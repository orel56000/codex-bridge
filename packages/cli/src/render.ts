import type { BridgeStatus } from '@codex-bridge/gateway';

/** Terminal rendering for `/codex-status` and `/logincodex`. Plain text only. */

const RULE = '────────────────────────';

export function renderStatus(s: BridgeStatus): string {
  const lines: string[] = ['Codex', RULE];

  const pad = (label: string): string => `${label}:`.padEnd(14);

  lines.push(`${pad('Status')}${s.account.connected ? 'Connected' : 'Not connected'}`);
  if (s.account.connected) {
    lines.push(`${pad('Auth')}${s.account.authMethod ?? 'unknown'}`);
    if (s.account.email) lines.push(`${pad('Account')}${s.account.email}`);
    lines.push(`${pad('Plan')}${s.account.plan ?? 'unknown'}`);
  }
  lines.push(`${pad('Gateway')}${s.gateway.running ? `Running (${s.gateway.url})` : 'Not running'}`);
  lines.push(`${pad('Codex Server')}${s.codex.appServerRunning ? 'Running' : 'Stopped'}`);
  lines.push(`${pad('Model')}${s.model.resolved ?? 'not resolved'}`);
  lines.push(
    `${pad('Claude Code')}${
      s.claudeCode.configured
        ? 'Routed through this gateway'
        : s.claudeCode.pointsElsewhere
          ? `Points at ${s.claudeCode.baseUrl} (not this gateway)`
          : 'Not configured'
    }`,
  );

  if (s.usage) {
    lines.push('', 'Usage');
    const windows = [s.usage.primary, s.usage.secondary].filter(Boolean);
    if (!windows.length) {
      lines.push('Codex did not report any usage windows.');
    } else {
      for (const w of windows) {
        if (!w) continue;
        const label = `${w.label} window:`.padEnd(16);
        const resets = w.resetsAt ? `  (resets ${formatWhen(w.resetsAt)})` : '';
        lines.push(`${label}${Math.round(w.usedPercent)}%${resets}`);
      }
    }
    if (s.usage.ordinaryUsageAllowed === false) {
      lines.push('', 'OpenAI is currently blocking included usage on this account.');
    }
  } else if (s.account.connected) {
    lines.push('', 'Usage', 'Not reported by Codex for this account.');
  }

  if (!s.account.connected) {
    lines.push('', 'Run /logincodex to connect your ChatGPT account.');
  } else if (!s.claudeCode.configured) {
    lines.push('', 'Claude Code is not routed through this gateway yet. Run /codex-doctor --fix,');
    lines.push('then start a new Claude Code session.');
  }
  return lines.join('\n');
}

export function renderLoginSuccess(s: BridgeStatus, configured: boolean): string {
  const lines = [
    '✓ OpenAI connected successfully',
    `✓ Authentication: ${s.account.authMethod ?? 'ChatGPT OAuth'}`,
    `✓ Plan: ChatGPT ${s.account.plan ?? 'unknown'}`,
    `✓ Gateway: ${s.gateway.url ?? 'not running'}`,
    '✓ Codex ready',
  ];
  if (s.account.email) lines.splice(1, 0, `✓ Account: ${s.account.email}`);
  if (configured) {
    lines.push(
      '',
      'Claude Code has been pointed at the local gateway.',
      'Start a new Claude Code session for it to take effect.',
    );
  }
  return lines.join('\n');
}

export function formatWhen(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return 'unknown';
  const deltaMs = d.getTime() - Date.now();
  if (deltaMs <= 0) return 'now';
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * `codex-bridge usage` — both plans side by side.
 *
 * Deliberately separate from `renderStatus`: this is the thing you check
 * repeatedly during a session, and it should not be buried under connection
 * details you already know.
 */
export function renderUsage(s: BridgeStatus): string {
  const lines: string[] = ['Usage', '────────────────────────'];

  lines.push('', 'Claude plan');
  if (s.claudeUsage) {
    const u = s.claudeUsage;
    const row = (label: string, w: BridgeStatus['claudeUsage'] extends null ? never : NonNullable<BridgeStatus['claudeUsage']>['fiveHour']): void => {
      if (w.utilization === null) {
        lines.push(`  ${`${label}:`.padEnd(16)}not reported`);
        return;
      }
      const resets = w.resetsAt ? `  (resets ${formatWhen(new Date(w.resetsAt * 1000).toISOString())})` : '';
      // Anthropic's own number, not rescaled — inventing a percentage from an
      // undocumented header is how a meter ends up confidently wrong.
      const blocked = w.status && w.status !== 'allowed' ? `  [${w.status}]` : '';
      lines.push(`  ${`${label}:`.padEnd(16)}${w.utilization}%${resets}${blocked}`);
    };
    row('5-hour window', u.fiveHour);
    row('7-day window', u.sevenDay);
    if (u.representativeClaim) lines.push(`  ${'binding limit:'.padEnd(16)}${u.representativeClaim}`);
    if (u.overageStatus && u.overageStatus !== 'allowed') {
      const why = u.overageDisabledReason ? ` (${u.overageDisabledReason})` : '';
      lines.push(`  ${'overage:'.padEnd(16)}${u.overageStatus}${why}`);
    }
    lines.push(`  ${'observed:'.padEnd(16)}${formatWhen(u.observedAt)}`);
  } else if (!s.claudeCode) {
    lines.push('  Not available.');
  } else {
    lines.push('  Not seen yet — use a Claude model once and run this again.');
    lines.push('  (Anthropic reports plan usage on answered requests, not on demand.)');
  }

  lines.push('', 'Codex / ChatGPT plan');
  if (s.usage) {
    const windows = [s.usage.primary, s.usage.secondary].filter(Boolean);
    if (!windows.length) {
      lines.push('  Codex reported no usage windows.');
    } else {
      for (const w of windows) {
        if (!w) continue;
        const resets = w.resetsAt ? `  (resets ${formatWhen(w.resetsAt)})` : '';
        lines.push(`  ${`${w.label} window:`.padEnd(16)}${Math.round(w.usedPercent)}%${resets}`);
      }
    }
    if (s.usage.ordinaryUsageAllowed === false) {
      lines.push('  OpenAI is currently blocking included usage on this account.');
    }
  } else if (s.account.connected) {
    lines.push('  Not reported by Codex for this account.');
  } else {
    lines.push('  Not connected. Run: codex-bridge login');
  }

  return lines.join('\n');
}
