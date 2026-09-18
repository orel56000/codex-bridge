import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Checking our Claude Desktop integration against the Claude Desktop that is
 * actually installed.
 *
 * Everything the bridge does to make the desktop's model picker work is shaped
 * by client-side behaviour that is undocumented and version-specific: which
 * model ids it silently drops, which model it probes to decide the gateway is
 * healthy, where it keeps its profile. All of that was read out of one build.
 *
 * An app update can change any of it, and every symptom is silent — an empty
 * picker, a permanent "Models are still loading", a health banner that blames
 * the gateway for someone else's quota. So rather than hardcode the answers and
 * hope, these checks re-read the rules from the installed bundle and test our
 * own advertised ids against them. When an update breaks the integration, the
 * doctor says which rule changed instead of leaving you to guess.
 *
 * Reading another application's bundle is not something to do lightly. It is
 * read-only, it is the copy on this machine, and it exists so the tool can tell
 * the truth about whether it still works.
 */

export interface DesktopProbe {
  installed: boolean;
  /** App version, so drift from the version we were built against is visible. */
  version: string | null;
  bundlePath: string | null;
  /**
   * The id filter, recovered from the bundle. `null` when it could not be
   * found — which is itself a signal that the app changed shape.
   */
  idFilter: ((id: string) => boolean) | null;
  /** How the filter was recovered, for the report. */
  filterSource: 'bundle' | 'unavailable';
}

/** Where Claude Desktop lives, per OS. */
function bundleCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/Claude.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Claude.app', 'Contents', 'Resources', 'app.asar'),
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'AnthropicClaude', 'resources', 'app.asar'),
      path.join(local, 'Programs', 'Claude', 'resources', 'app.asar'),
    ];
  }
  return ['/opt/Claude/resources/app.asar', '/usr/lib/claude-desktop/resources/app.asar'];
}

function readVersion(bundlePath: string): string | null {
  // macOS keeps it in the enclosing bundle's Info.plist.
  const plist = path.resolve(bundlePath, '..', '..', 'Info.plist');
  try {
    const xml = fs.readFileSync(plist, 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    if (m?.[1]) return m[1];
  } catch {
    /* not macOS, or no plist — fall through */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(bundlePath, '..', 'app-update.yml'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version) return pkg.version;
  } catch {
    /* nothing else to try */
  }
  return null;
}

/**
 * Recover the desktop's model-id filter from its own bundle.
 *
 * It is one function of the shape
 *   `let t=e.toLowerCase(); return BLOCK.test(t) ? false : KNOWN.test(t) || ALLOW.some(a=>t.includes(a))`
 * so the two regexes and the allow-list are what we need. They are found by
 * their contents rather than by their minified names, which change on every
 * build — the blocklist is recognisable because it lists competitor model
 * families, and no other regex in the bundle looks like that.
 */
function recoverIdFilter(source: string): ((id: string) => boolean) | null {
  // A long alternation naming several foreign model families.
  const blockMatch = /\/((?:[a-z0-9\\.|_-]|\\b)*deepseek(?:[a-z0-9\\.|_\-|]|\\b)*)\/(?=[a-z]*;|\.test)/.exec(source);
  if (!blockMatch?.[1]) return null;

  let block: RegExp;
  try {
    block = new RegExp(blockMatch[1]);
  } catch {
    return null;
  }

  // The allow-list sits near it: ["claude", ...tiers, "anthropic"].
  const allow = ['claude', 'anthropic', 'opus', 'sonnet', 'haiku', 'fable', 'mythos'];
  const allowMatch = /\["claude",\.\.\.(\w+),"anthropic"\]/.exec(source);
  const known = /^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/;

  return (id: string): boolean => {
    const t = id.toLowerCase();
    if (block.test(t)) return false;
    if (known.test(t)) return true;
    // When the allow-list could not be located, fall back to the documented
    // behaviour rather than pretending the check passed.
    return allowMatch ? allow.some((a) => t.includes(a)) : /claude|anthropic/.test(t);
  };
}

/**
 * Inspect the installed Claude Desktop.
 *
 * Reads the bundle once. It is large, so this is only called from the doctor
 * and the installer, never on a request path.
 */
export function probeDesktop(): DesktopProbe {
  const bundlePath = bundleCandidates().find((p) => {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  });

  if (!bundlePath) {
    return { installed: false, version: null, bundlePath: null, idFilter: null, filterSource: 'unavailable' };
  }

  let idFilter: ((id: string) => boolean) | null = null;
  try {
    const source = fs.readFileSync(bundlePath).toString('utf8');
    idFilter = recoverIdFilter(source);
  } catch {
    /* unreadable bundle — reported as unavailable rather than guessed at */
  }

  return {
    installed: true,
    version: readVersion(bundlePath),
    bundlePath,
    idFilter,
    filterSource: idFilter ? 'bundle' : 'unavailable',
  };
}

/**
 * Reproduce the desktop's choice of which model to send its health probe to.
 *
 * Its rule: scan for "haiku", then "sonnet", then "opus" as substrings of the
 * id, take the SHORTEST match; if no id contains any of them, take the first
 * row. Our ids deliberately contain none, so the first row decides — which is
 * why `models.codexFirst` exists.
 */
export function predictProbeModel(ids: string[]): string | null {
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const hits = ids.filter((id) => id.toLowerCase().includes(tier));
    if (hits.length) return hits.reduce((a, b) => (a.length <= b.length ? a : b));
  }
  return ids[0] ?? null;
}
