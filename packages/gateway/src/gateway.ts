import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { BridgeConfig, Logger } from '@codex-bridge/shared';
import {
  BridgeError,
  ERRORS,
  codexInstallHint,
  findCodexBinary,
  openBrowser,
  saveConfig,
} from '@codex-bridge/shared';
import { CodexAppServerClient } from '@codex-bridge/codex-client';
import { GatewayHttpServer } from './http/server.js';
import { readJsonBody, readJsonBodyWithRaw, validateMessagesRequest } from './http/body.js';
import { sendJson, sendText } from './http/respond.js';
import { handleMessages } from './routes/messages.js';
import { handleCountTokens } from './routes/count-tokens.js';
import { ModelMapper } from './models.js';
import { SessionManager } from './session.js';
import { collectStatus, type BridgeStatus } from './status.js';
import { managementPage } from './ui/page.js';
import { readClaudeCodeConfig } from './claude-config.js';
import { AnthropicPassthrough, isAnthropicModel } from './passthrough.js';
import {
  isBridgeModelId,
  restoreTierWord,
  shortlistClaudeModels,
  stripDescriptions,
  type ApiModelRow,
} from './models.js';
import { runDoctor } from './doctor.js';

export interface GatewayOptions {
  config: BridgeConfig;
  logger: Logger;
  /** Default cwd for Codex threads when the system prompt does not state one. */
  defaultCwd?: string;
}

export interface StartedGateway {
  url: string;
  port: number;
  movedFrom: number | null;
  authToken: string;
  stop(): Promise<void>;
}

/**
 * Wires the Codex client, the session map and the HTTP surface together.
 *
 * Owns process lifetime concerns that must not live in a route handler:
 * generating the gateway token, binding a port, and shutting everything down
 * without leaving an orphaned App Server behind.
 */
export class Gateway {
  readonly client: CodexAppServerClient;
  readonly sessions: SessionManager;
  readonly models: ModelMapper;
  readonly passthrough: AnthropicPassthrough;
  private readonly http: GatewayHttpServer;
  private readonly logger: Logger;
  private readonly config: BridgeConfig;
  private readonly startedAt = Date.now();
  private readonly defaultCwd: string;
  private codexVersion: string | null = null;
  private authToken: string;
  private stopping = false;
  /** State of the most recent `/admin/login`, polled by `codex-bridge login --wait`. */
  private login: {
    loginId: string;
    kind: 'browser' | 'deviceCode';
    url: string;
    userCode?: string;
    startedAt: number;
    status: 'pending' | 'success' | 'failed';
    error: string | null;
  } | null = null;

  constructor(opts: GatewayOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.defaultCwd = opts.defaultCwd ?? process.cwd();

    this.authToken = opts.config.gateway.authToken ?? generateToken();
    if (!opts.config.gateway.authToken) {
      // Persist it so the plugin and Claude Code can be configured with the
      // same value across restarts.
      saveConfig({ gateway: { authToken: this.authToken } });
      this.config.gateway.authToken = this.authToken;
    }

    this.client = new CodexAppServerClient({
      logger: this.logger,
      binPath: opts.config.codex.binPath,
      configOverrides: opts.config.codex.configOverrides,
      allowNativeTools: opts.config.codex.allowNativeTools,
      login: {
        appBrand: opts.config.codex.login.appBrand,
        useHostedSuccessPage: opts.config.codex.login.useHostedSuccessPage,
      },
    });

    this.sessions = new SessionManager({
      client: this.client,
      logger: this.logger,
      idleTtlMs: opts.config.session.idleTtlMs,
      maxThreads: opts.config.session.maxThreads,
    });

    this.models = new ModelMapper(this.client, this.logger, {
      model: opts.config.codex.model,
      aliases: opts.config.codex.modelAliases,
      effort: opts.config.codex.reasoningEffort,
    });

    this.passthrough = new AnthropicPassthrough(opts.config.anthropic, this.logger);

    this.http = new GatewayHttpServer({
      host: opts.config.gateway.host,
      port: opts.config.gateway.port,
      logger: this.logger,
      authToken: this.authToken,
      // Only these three are reachable without the token. `/admin/*` is NOT
      // public: the management page is served with the token embedded, and
      // sends it as a bearer like any other client.
      publicPaths: ['/', '/health', '/api/hello'],
    });

    this.registerRoutes();
  }

  get token(): string {
    return this.authToken;
  }

  async start(): Promise<StartedGateway> {
    if (!findCodexBinary() && !this.config.codex.binPath) {
      throw ERRORS.codexNotInstalled(codexInstallHint());
    }

    await this.client.initialize();
    // Reported in diagnostics only, so it must never delay a startup.
    void readCodexVersion(this.client.codexBinary).then((v) => {
      this.codexVersion = v;
    });
    await this.models.refresh(true).catch(() => undefined);

    let port: number;
    let movedFrom: number | null;
    try {
      ({ port, movedFrom } = await this.http.listen());
    } catch (err) {
      // The App Server is already running at this point. Without this, a
      // machine whose ports are all taken accumulates one orphaned
      // `codex app-server` per Claude Code session.
      await this.client.shutdown().catch(() => undefined);
      throw err;
    }
    if (movedFrom !== null) {
      this.logger.warn(`Port ${movedFrom} is already in use. Using port ${port}.`);
    }
    const url = `http://${this.config.gateway.host}:${port}`;
    this.logger.info('gateway listening', { url });

    const stop = async (): Promise<void> => this.stop();
    return { url, port, movedFrom, authToken: this.authToken, stop };
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('gateway stopping');
    this.sessions.persist();
    await this.http.close();
    await this.client.shutdown();
  }

  /**
   * Exactly what `/v1/models` advertises, in order.
   *
   * A method rather than inline in the route because the doctor checks these
   * same ids against the installed Claude Desktop's rules. Computing them
   * twice would let the check and the reality drift apart, which is the one
   * thing a self-check must never do.
   */
  async advertisedModels(): Promise<Array<Record<string, unknown> | ApiModelRow>> {
    await this.models.refresh();
    const all = await this.passthrough.listModels();
    let upstream = shortlistClaudeModels(all, this.config.models.claudeFamilies);
    if (!this.config.models.descriptions) upstream = stripDescriptions(upstream);
    // Real Claude models keep their own tiers; Codex only claims the tier
    // defaults when it is the sole provider. Key that off what Anthropic
    // actually returned, not off the shortlist — a shortlist that matched
    // nothing must not silently hand the slots back to Codex.
    const codex = this.models.listForApi({
      claimTierDefaults: all.length === 0,
      codexLimit: this.config.models.codexLimit,
      descriptions: this.config.models.descriptions,
    });
    // Order is not cosmetic: the desktop probes the FIRST row and also uses it
    // as the default model. See `models.codexFirst`.
    return this.config.models.codexFirst ? [...codex, ...upstream] : [...upstream, ...codex];
  }

  async status(): Promise<BridgeStatus> {
    return collectStatus({
      client: this.client,
      models: this.models,
      sessions: this.sessions,
      host: this.config.gateway.host,
      port: this.http.port,
      startedAt: this.startedAt,
      codexVersion: this.codexVersion,
      claudeCode: readClaudeCodeConfig(),
      claudeUsage: this.passthrough.usage,
    });
  }

  /**
   * Put the real Anthropic model id back before forwarding.
   *
   * When descriptions are turned off we advertise `claude-cbxo-5` rather than
   * `claude-opus-5`, because the desktop builds a picker blurb out of the
   * family word in the id. Anthropic has never heard of that name, so it has to
   * be restored on the way out.
   *
   * Returns the body to send — the original buffer untouched whenever nothing
   * needs rewriting, so the ordinary path stays byte-for-byte verbatim.
   */
  private restoreUpstreamModel(raw: unknown, buffer: Buffer): { body: Buffer; model: string | undefined } {
    const requested = (raw as { model?: string } | null)?.model;
    if (!this.config.models.descriptions && typeof requested === 'string') {
      // A context-window suffix must survive the round trip: `foo[1m]`.
      const suffix = /\[[^\]]*\]$/.exec(requested)?.[0] ?? '';
      const bare = suffix ? requested.slice(0, -suffix.length) : requested;
      const real = `${restoreTierWord(bare)}${suffix}`;
      if (real !== requested) {
        return { body: Buffer.from(JSON.stringify({ ...(raw as object), model: real })), model: real };
      }
    }
    return { body: buffer, model: requested };
  }

  /* -------------------------------- routes -------------------------------- */

  private registerRoutes(): void {
    const maxBody = this.config.gateway.maxBodyBytes;

    this.http.route('POST', '/v1/messages', async ({ req, res, url }) => {
      const { raw, buffer } = await readJsonBodyWithRaw(req, maxBody);

      // Route BEFORE validating: an Anthropic-bound request is forwarded
      // verbatim, so it must not be held to our translator's expectations.
      const requested = (raw as { model?: string } | null)?.model;
      if (this.passthrough.enabled && isAnthropicModel(requested, isBridgeModelId)) {
        const out = this.restoreUpstreamModel(raw, buffer);
        await this.passthrough.forward(req, res, `${url.pathname}${url.search}`, out.body);
        return;
      }

      const body = validateMessagesRequest(raw);
      await handleMessages(req, res, body, {
        client: this.client,
        sessions: this.sessions,
        models: this.models,
        logger: this.logger,
        allowNativeTools: this.config.codex.allowNativeTools,
        defaultCwd: this.defaultCwd,
        requestTimeoutMs: this.config.gateway.requestTimeoutMs,
      });
    });

    this.http.route('POST', '/v1/messages/count_tokens', async ({ req, res, url }) => {
      const { raw, buffer } = await readJsonBodyWithRaw(req, maxBody);
      if (!raw || typeof raw !== 'object') throw ERRORS.invalid('Request body must be a JSON object.');
      const requested = (raw as { model?: string }).model;
      if (this.passthrough.enabled && isAnthropicModel(requested, isBridgeModelId)) {
        // Anthropic counts its own tokens exactly; ours is an estimate.
        const out = this.restoreUpstreamModel(raw, buffer);
        await this.passthrough.forward(req, res, `${url.pathname}${url.search}`, out.body);
        return;
      }
      handleCountTokens(res, raw as never);
    });

    this.http.route('GET', '/v1/models', async ({ res }) => {
      sendJson(res, 200, {
        data: await this.advertisedModels(),
        has_more: false,
        first_id: null,
        last_id: null,
      });
    });

    this.http.route('POST', '/admin/doctor', async ({ res }) => {
      const report = await runDoctor({
        config: this.config,
        client: this.client,
        models: this.models,
        status: await this.status(),
        // The doctor checks the ids we ACTUALLY advertise against the rules of
        // the Claude Desktop that is actually installed, so an app update that
        // changes those rules is reported rather than silently breaking things.
        advertisedIds: (await this.advertisedModels().catch(() => [])).map((m) => String(m['id'])),
      });
      sendJson(res, 200, { report: report.text, ok: report.ok });
    });

    // Claude Code sends a HEAD probe here at startup. It is not a health gate;
    // any response is fine, but answering it keeps the logs clean.
    this.http.route('HEAD', '/api/hello', ({ res }) => {
      res.writeHead(200).end();
    });
    this.http.route('GET', '/api/hello', ({ res }) => {
      sendJson(res, 200, { ok: true });
    });

    this.http.route('GET', '/health', ({ res }) => {
      sendJson(res, 200, {
        status: this.client.isRunning ? 'ok' : 'degraded',
        codexAppServer: this.client.isRunning,
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        version: '0.1.0',
      });
    });

    /* ------------------------------ local UI ------------------------------ */

    if (this.config.gateway.managementUi) {
      this.http.route('GET', '/', ({ res }) => {
        // The page is only reachable from loopback with a same-origin request,
        // so embedding the token is no more exposure than the state file it
        // already lives in — and it lets /admin/* require authentication.
        sendText(res, 200, managementPage(this.authToken), 'text/html; charset=utf-8');
      });
    }

    this.http.route('GET', '/admin/status', async ({ res }) => {
      sendJson(res, 200, await this.status());
    });

    this.http.route('POST', '/admin/restart', async ({ res }) => {
      this.sessions.clear('Codex App Server restarted');
      await this.client.shutdown();
      await this.client.initialize();
      await this.models.refresh(true).catch(() => undefined);
      sendJson(res, 200, { ok: true });
    });

    this.http.route('POST', '/admin/login', async ({ req, res }) => {
      const raw = await readJsonBody<{ mode?: string; open?: boolean; switchAccount?: boolean }>(
        req,
        4096,
      ).catch(() => ({}) as never);
      const mode = raw?.mode === 'deviceCode' ? 'deviceCode' : 'browser';

      // Switching accounts must always start a fresh flow, never re-use the
      // pending one — the whole point is to pick a different account.
      if (raw?.switchAccount && this.login?.status === 'pending') {
        await this.client.cancelLogin(this.login.loginId).catch(() => undefined);
        this.login = null;
      }

      if (this.login?.status === 'pending' && Date.now() - this.login.startedAt < 15 * 60_000) {
        sendJson(res, 200, { ...this.login, reused: true });
        return;
      }

      // Remember who we were, so a completed login that lands on a different
      // account can drop Codex threads that belong to the previous one.
      const previousEmail = (await this.status().catch(() => null))?.account.email ?? null;

      const session = await this.client.startLogin(mode);
      const opened = raw?.open === false ? { ok: false } : await openBrowser(session.url);
      this.login = {
        loginId: session.loginId,
        kind: session.kind,
        url: session.url,
        ...(session.userCode ? { userCode: session.userCode } : {}),
        startedAt: Date.now(),
        status: 'pending',
        error: null,
      };
      // Never block the HTTP response on the user finishing a browser flow.
      void session.completed.then(async (r) => {
        this.logger.info('login completed', { success: r.success });
        if (this.login?.loginId !== session.loginId) return;
        this.login.status = r.success ? 'success' : 'failed';
        this.login.error = r.error;
        if (!r.success) return;
        // A different account means different context and a different quota;
        // threads created for the old one must not be reused.
        const account = await this.client.getAccount(true).catch(() => null);
        if (account && account.email !== previousEmail) {
          this.sessions.clear('signed in as a different account');
          this.logger.info('account switched; cleared Codex threads');
        }
      });
      sendJson(res, 200, { ...this.login, browserOpened: opened.ok, reused: false });
    });

    this.http.route('GET', '/admin/login/status', async ({ res }) => {
      const status = await this.status();
      sendJson(res, 200, {
        login: this.login,
        connected: status.account.connected,
        account: status.account,
      });
    });

    this.http.route('POST', '/admin/login/cancel', async ({ res }) => {
      if (this.login?.status === 'pending') {
        await this.client.cancelLogin(this.login.loginId).catch(() => undefined);
        this.login.status = 'failed';
        this.login.error = 'cancelled';
      }
      sendJson(res, 200, { ok: true });
    });

    this.http.route('POST', '/admin/logout', async ({ res }) => {
      await this.client.logout();
      this.sessions.clear('signed out');
      this.login = null;
      sendJson(res, 200, { ok: true });
    });

    this.http.route('POST', '/admin/sessions/clear', ({ res }) => {
      this.sessions.clear('cleared from the management page');
      sendJson(res, 200, { ok: true });
    });
  }
}

/* -------------------------------- helpers -------------------------------- */

export function generateToken(): string {
  return `cbk_${randomBytes(24).toString('base64url')}`;
}

function readCodexVersion(bin: string | null): Promise<string | null> {
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim().split('\n')[0] ?? null);
    });
  });
}

export { BridgeError };
