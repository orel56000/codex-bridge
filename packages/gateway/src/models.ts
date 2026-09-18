import type { Logger } from '@codex-bridge/shared';
import type { CodexAppServerClient, CodexModel } from '@codex-bridge/codex-client';

/**
 * Model mapping.
 *
 * Claude Code sends Anthropic model names (and, when configured, whatever the
 * user typed). Codex publishes its own catalogue through `model/list`, so the
 * default model is discovered rather than hardcoded — a Codex upgrade that
 * retires a model must not brick the bridge.
 */

export interface ModelResolution {
  /** The Codex model id to use. */
  codexModel: string;
  /** The model name to echo back to Claude Code (always what it asked for). */
  reportedModel: string;
  /**
   * Reasoning effort to pass explicitly on every turn.
   *
   * Without this the bridge inherits `model_reasoning_effort` from the user's
   * own Codex config, so two people on the same version would get wildly
   * different latency. Configured value first, else the model's own default.
   */
  effort: string | null;
  /** How the mapping was decided, for diagnostics. */
  via: 'alias' | 'exact' | 'default' | 'configured';
}

/**
 * The ids we advertise through `/v1/models`, and why they look like this.
 *
 * Two independent filters have to be satisfied, and they pull opposite ways:
 *
 * 1. **Claude Code (CLI)** drops any id that does not contain "claude" or
 *    "anthropic" (case-insensitive) — so the id must claim to be Claude.
 * 2. **Claude Code Desktop** additionally runs the id past a blocklist of
 *    foreign-model words, and that list contains both `codex` and `gpt`. A row
 *    it rejects is removed silently, leaving an empty picker and a permanent
 *    "Models are still loading. Try again in a moment."
 *
 * So the obvious names (`claude-codex-sonnet`, `claude-codex-gpt-5.6-sol`) are
 * exactly the ones that cannot work. The id therefore carries no vendor word at
 * all; `display_name` is where "Codex" is stated, and labels are not filtered.
 *
 * Kept here so the next person who tries to "clean up" these names sees why.
 */
const DESKTOP_REJECTS = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;

/** Would both clients accept this id? Used to assert our own naming stays legal. */
export function isAcceptableModelId(id: string): boolean {
  const t = id.toLowerCase();
  if (DESKTOP_REJECTS.test(t)) return false;
  return /claude|anthropic/.test(t);
}

/** `claude-opus-bridge` … — a tier slot, meaning "Codex, whichever model". */
const BRIDGE_TIER_ID = /^claude-(opus|sonnet|haiku)-bridge$/;
/**
 * `claude-bridge-5-6-sol` — one specific Codex model, pinned.
 *
 * No tier word in the id on purpose: Claude Code Desktop writes a picker blurb
 * for any id containing one ("sonnet" → "Most efficient for everyday tasks"),
 * and there is no setting to suppress it. See {@link TIER_WORD}.
 */
const BRIDGE_MODEL_ID = /^claude-bridge-(.+)$/;

/**
 * Is this one of the ids we advertise?
 *
 * The routing predicate for the dual-backend picker: anything that is ours goes
 * to Codex, anything else that looks Anthropic goes upstream. It must not be a
 * simple prefix test — `claude-opus-bridge` and `claude-sonnet-bridge-…` share
 * no common prefix, and a prefix test would hand the Opus and Haiku slots to
 * Anthropic instead of to Codex.
 */
export function isBridgeModelId(model: string | undefined): boolean {
  if (!model) return false;
  const t = stripContextSuffix(model.trim()).toLowerCase();
  return BRIDGE_TIER_ID.test(t) || BRIDGE_MODEL_ID.test(t);
}

/** Turn a Codex model id into a suffix that survives both filters. */
export function codexIdToSuffix(codexId: string): string {
  return codexId
    .toLowerCase()
    .replace(/^gpt-?/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Names Claude Code may send that mean "whatever Codex thinks is best". */
const GENERIC_ALIASES = new Set([
  'codex',
  'codex-default',
  'codex-auto',
  'default',
  'auto',
]);

export class ModelMapper {
  private models: CodexModel[] = [];
  private defaultModel: string | null = null;
  private lastRefresh = 0;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly configured: {
      model: string;
      aliases: Record<string, string>;
      effort?: string | null;
    },
  ) {}

  get catalogue(): CodexModel[] {
    return this.models;
  }

  get resolvedDefault(): string | null {
    return this.defaultModel;
  }

  async refresh(force = false): Promise<void> {
    // An empty catalogue always retries, regardless of the cache window: an
    // unresolved model means we send no `model` at all, and Codex then falls
    // back to whatever `~/.codex/config.toml` says — so the bridge would
    // silently use a different model per machine.
    const haveCatalogue = this.models.length > 0;
    if (!force && haveCatalogue && Date.now() - this.lastRefresh < 5 * 60_000) return;
    try {
      this.models = await this.client.listModels(force);
      this.defaultModel = this.models.find((m) => m.isDefault)?.id ?? this.models[0]?.id ?? null;
      this.lastRefresh = Date.now();
      this.logger.debug('model catalogue refreshed', {
        count: this.models.length,
        default: this.defaultModel,
      });
    } catch (err) {
      // A stale catalogue is better than failing the request; `resolve` falls
      // back to letting Codex pick when nothing is known.
      this.logger.debug('model/list failed', { err });
    }
  }

  /**
   * Resolve the model for a request.
   *
   * Order: explicit alias from config, exact Codex model id, configured default,
   * Codex's own default. An unknown Anthropic model name never fails the
   * request — it maps to the default, which is what a gateway user expects.
   */
  async resolve(requested: string | undefined): Promise<ModelResolution> {
    await this.refresh();
    if (!this.defaultModel) {
      // First request after a restart can land before `model/list` answers.
      await this.refresh(true);
      if (!this.defaultModel) {
        this.logger.warn('no Codex model could be resolved; Codex will pick from its own config');
      }
    }
    const reported = requested ?? 'codex';
    let want = stripContextSuffix((requested ?? '').trim());
    const bridged = this.matchBridgeId(want);
    if (bridged !== null) want = bridged;

    const finish = (codexModel: string, via: ModelResolution['via']): ModelResolution => ({
      codexModel,
      reportedModel: reported,
      effort: this.effortFor(codexModel),
      via,
    });

    const alias = this.configured.aliases[want];
    if (alias) return finish(this.expand(alias), 'alias');

    if (want && !GENERIC_ALIASES.has(want.toLowerCase())) {
      const exact = this.models.find((m) => m.id === want || m.model === want);
      if (exact) return finish(exact.id, 'exact');
    }

    if (this.configured.model && this.configured.model !== 'auto') {
      return finish(this.expand(this.configured.model), 'configured');
    }

    return finish(this.defaultModel ?? '', 'default');
  }

  /**
   * Map one of our advertised ids back to the Codex model it stands for.
   * Returns '' for a tier alias (meaning "the default"), or null if not ours.
   */
  private matchBridgeId(id: string): string | null {
    const t = id.toLowerCase();
    if (BRIDGE_TIER_ID.test(t)) return '';
    const m = BRIDGE_MODEL_ID.exec(t);
    if (!m) return null;
    const suffix = m[1] as string;
    const hit = this.models.find((model) => codexIdToSuffix(model.id) === suffix);
    return hit ? hit.id : '';
  }

  private effortFor(codexModel: string): string | null {
    if (this.configured.effort) return this.configured.effort;
    const model = this.models.find((m) => m.id === codexModel);
    return model?.defaultReasoningEffort ?? null;
  }

  private expand(value: string): string {
    if (value === 'auto' || value === 'default') return this.defaultModel ?? '';
    return value;
  }

  /**
   * Codex models rendered as an Anthropic-style `/v1/models` listing.
   *
   * Two consumers with different rules:
   *
   * 1. Claude Code (CLI) drops any id that does not contain "claude" or
   *    "anthropic"; the desktop additionally blocklists foreign-vendor words.
   *    See {@link isAcceptableModelId} for why the ids read the way they do.
   * 2. Claude Code Desktop's third-party inference discovery drops any row that
   *    is neither a *known Anthropic model id* nor carries an
   *    `anthropic_family_tier`. Since our ids are deliberately not real
   *    Anthropic ids, the tier is what keeps them — without it discovery
   *    reports "Gateway returned no usable models" and nothing can be selected.
   *
   * The three tier-alias rows exist so a bare `opus` / `sonnet` / `haiku`
   * request resolves to Codex, which is the same thing the CLI env vars do.
   */
  listForApi(
    opts: { claimTierDefaults?: boolean; codexLimit?: number | null; descriptions?: boolean } = {},
  ): ApiModelRow[] {
    // When real Claude models are also on offer, Codex must NOT own the tier
    // defaults — otherwise picking "Opus" would silently get you Codex, which
    // is the opposite of being able to choose.
    const claimTierDefaults = opts.claimTierDefaults ?? true;
    const limit = opts.codexLimit ?? null;
    // Empty, not absent: the desktop falls back to a canned tier blurb when a
    // row carries no description at all.
    const describe = (text: string): string => (opts.descriptions === false ? '' : truncate(text, 100));
    const created = new Date(0).toISOString();
    const rows: ApiModelRow[] = [];

    // With a limit set, the tier aliases go first. They exist to make Codex
    // selectable when it is the only provider; once real Claude models hold
    // those slots they are three extra rows saying the same thing as the
    // concrete models below, which is exactly the clutter a limit is asking to
    // remove.
    const tierRows = limit === null ? FAMILY_TIERS : [];
    for (const tier of tierRows) {
      rows.push({
        id: `claude-${tier}-bridge`,
        type: 'model',
        display_name: `Codex (${tier} slot)`,
        created_at: created,
        description: describe('OpenAI Codex via your ChatGPT subscription.'),
        anthropic_family_tier: tier,
        is_family_default: claimTierDefaults,
      });
    }

    // Then the models Codex actually reports, so a specific one can be pinned.
    // Codex's own default leads, because that is the one a bare pick gets.
    const ordered = [...this.models].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    for (const m of limit === null ? ordered : ordered.slice(0, limit)) {
      rows.push({
        id: `claude-bridge-${codexIdToSuffix(m.id)}`,
        type: 'model',
        display_name: `Codex ${m.displayName || m.id}`,
        created_at: created,
        description: describe(m.description || `Codex ${m.id}.`),
        // Tiering every concrete model as the workhorse keeps them selectable
        // without pretending a Codex model "is" an Opus or a Haiku.
        anthropic_family_tier: 'sonnet',
        is_family_default: false,
      });
    }

    return rows;
  }
}

/** Families that appear in an Anthropic model id. */
const CLAUDE_FAMILY = /\b(opus|sonnet|haiku|fable|mythos)\b/;

/**
 * Cut Anthropic's model list down to the newest of each named family.
 *
 * Anthropic publishes every version it still serves, so the picker ends up
 * listing Opus 4.8, 4.7, 4.6 and 4.5 alongside Opus 5. Only the newest of a
 * family is a real choice; the rest are noise you scroll past.
 *
 * `families` is matched against the family word in the id, so "opus" keeps
 * whichever Opus is newest without naming a version that will age out. Rows
 * whose id names no family are dropped when a shortlist is in force — an id we
 * cannot classify is not one we can promise is current.
 *
 * Nothing here affects what can be *used*: an unlisted model still resolves
 * when a request names it, so this only changes what is advertised.
 */
export function shortlistClaudeModels(
  rows: Array<Record<string, unknown>>,
  families: string[] | null,
): Array<Record<string, unknown>> {
  if (!families?.length) return rows;
  const want = new Set(families.map((f) => f.toLowerCase()));

  // Newest first, so the first row seen for a family is the one to keep.
  // `created_at` is authoritative; list order is not promised.
  const sorted = [...rows].sort((a, b) => String(b['created_at'] ?? '').localeCompare(String(a['created_at'] ?? '')));

  const kept = new Map<string, Record<string, unknown>>();
  for (const row of sorted) {
    const family = CLAUDE_FAMILY.exec(String(row['id'] ?? '').toLowerCase())?.[1];
    if (!family || !want.has(family) || kept.has(family)) continue;
    kept.set(family, row);
  }

  // Emit in the order the caller asked for, so the picker reads as requested.
  return families.map((f) => kept.get(f.toLowerCase())).filter((r): r is Record<string, unknown> => Boolean(r));
}

/**
 * The family words Claude Code Desktop looks for inside a model id.
 *
 * Its rule is `FAMILIES.find(f => id.includes(f))`, and a hit becomes the
 * picker blurb — "Most capable for ambitious work" and friends. The word can be
 * anywhere in the id, and there is no config key that turns this off.
 */
const TIER_WORD = /(opus|sonnet|haiku|fable|mythos)/;

/** Short, reversible stand-ins, so a neutral id still says which model it is. */
const TIER_CODES: Record<string, string> = {
  opus: 'cbxo',
  sonnet: 'cbxs',
  haiku: 'cbxh',
  fable: 'cbxf',
  mythos: 'cbxm',
};
const CODE_TO_TIER = new Map(Object.entries(TIER_CODES).map(([tier, code]) => [code, tier]));
const TIER_CODE = new RegExp(`(${[...CODE_TO_TIER.keys()].join('|')})`);

/**
 * Hide the family word in an Anthropic model id.
 *
 * `claude-opus-5` → `claude-cbxo-5`. The id still starts with "claude", so both
 * clients keep it, and it no longer matches {@link TIER_WORD}, so the desktop
 * has nothing to build a blurb from. The visible name is unaffected: that comes
 * from `display_name`, which we keep as Anthropic wrote it.
 *
 * Deliberately a pure, reversible transform rather than a lookup table, so a
 * request that arrives before `/v1/models` has been called still resolves —
 * there is no map to be populated first and no window where it is empty.
 */
export function hideTierWord(id: string): string {
  return id.replace(TIER_WORD, (word) => TIER_CODES[word] ?? word);
}

/** Undo {@link hideTierWord}, so the real id is what reaches Anthropic. */
export function restoreTierWord(id: string): string {
  return id.replace(TIER_CODE, (code) => CODE_TO_TIER.get(code) ?? code);
}

/**
 * Strip everything a client could turn into picker chrome.
 *
 * Three separate things had to go, and each was its own surprise:
 *
 * 1. **The description itself.** Sent empty rather than omitted, for clients
 *    that use it. Note this alone does nothing for Claude Code Desktop: its
 *    discovery mapper spreads `...description && {description}`, and an empty
 *    string is falsy, so the field is simply dropped and the fallbacks below
 *    take over.
 * 2. **The family word in the id.** The desktop's real fallback is
 *    `FAMILIES.find(f => id.includes(f))`, which turns `claude-opus-5` into
 *    "Most capable for ambitious work". Neutralising the id is what actually
 *    removes the blurb — see {@link hideTierWord}.
 * 3. **`max_input_tokens` / `supports_1m`.** Anthropic's own `/v1/models` rows
 *    carry these, and the desktop reads either one as "this model has a 1M
 *    variant", silently doubling every Claude row into a second entry
 *    subtitled "1M context window". Codex rows never had them, which is why
 *    only the Claude half of the list grew.
 */
export function stripDescriptions(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const { max_input_tokens: _max, supports_1m: _1m, ...rest } = row;
    return { ...rest, description: '', id: hideTierWord(String(row['id'] ?? '')) };
  });
}

/** Tiers Claude Code Desktop accepts for `anthropic_family_tier`. */
export const FAMILY_TIERS = ['opus', 'sonnet', 'haiku'] as const;

export interface ApiModelRow {
  id: string;
  type: 'model';
  display_name: string;
  created_at: string;
  description: string;
  anthropic_family_tier: (typeof FAMILY_TIERS)[number];
  is_family_default: boolean;
}

/** The desktop truncates descriptions at 100 characters; do it ourselves. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Best-effort working directory for a Codex thread.
 *
 * Claude Code states the project directory inside its system prompt; using it
 * keeps file paths in tool arguments meaningful to the model. When it cannot be
 * found we fall back to the gateway's own cwd, which is harmless because Codex
 * is not permitted to touch the filesystem anyway.
 */
/**
 * Drop Claude Code's context-window suffix.
 *
 * With the 1M-context beta enabled it asks for `sonnet[1m]` — and with our
 * aliases in place, `codex[1m]`. Stripping the suffix lets an explicit alias or
 * an exact Codex model id still match instead of falling through to the
 * default.
 *
 * Note this does NOT silence Claude Code's own
 * `[claude-code:unrecognized_model]` log line: that is emitted client-side
 * before the request is sent, and any custom model name triggers it.
 */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

export function extractWorkingDirectory(systemPrompt: string, fallback: string): string {
  const patterns = [
    /Working directory:\s*(\S[^\n<]*)/i,
    /<cwd>\s*([^<\n]+?)\s*<\/cwd>/i,
    /Current working directory:\s*(\S[^\n<]*)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(systemPrompt);
    const value = m?.[1]?.trim();
    if (value && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))) return value;
  }
  return fallback;
}
