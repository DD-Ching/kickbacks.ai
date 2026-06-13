import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readConfig, resolveBackendBase } from "../config";
import { isLoopbackBase } from "../util/loopback";
import { buildVersion } from "../buildinfo";
import { PortfolioClient, type PortfolioResponse, type PatchAd }
  from "../portfolio/client";
import { MetricsClient } from "../metrics/client";
import { KillSwitchClient } from "../killswitch/client";
import { resolveCcVersion } from "./ccVersion";
import { LogTail } from "../activity/logTail";
import { locateClaudeCliLog } from "../locate";
import { setupCliTick } from "../activation/cliTick";
import { ClaudeCliStatuslineAdapter } from "../adapters/claude-cli/adapter";
import { CliAuth } from "./vaultAuth";
import { CliSurface } from "./sync";
import { cliClientEnv } from "./clientEnv";

// ── Standalone Kickbacks CLI ────────────────────────────────────────────────
// Lets developers who run `claude` purely in the terminal — no VS Code, no
// extension host — earn from the statusline + spinner-verb ad surfaces. It is a
// thin, vscode-free host around the SAME building blocks the extension uses:
// the ClaudeCliStatuslineAdapter (official ~/.claude/settings.json statusLine +
// spinnerVerbs customization points), the portfolio/metrics/killswitch wire
// clients, and — unchanged — the extension's own setupCliTick view-tick billing
// loop. Auth shares the extension's ~/.kickbacks/auth.json session (see
// vaultAuth.ts), so signing in once works on both surfaces.

const out = (m = ""): void => { try { process.stdout.write(m + "\n"); } catch { /* ignore */ } };

/** Resolve the backend base URL: ~/.vibe-ads/config.json > env > prod default,
 *  refusing a non-loopback plain-HTTP base exactly like extension.ts. */
function resolveBase(): string {
  const cfg = readConfig();
  const v = resolveBackendBase(cfg,
    process.env.KICKBACKS_BASE || process.env.VIBE_ADS_BASE);
  if (v.startsWith("http://") && !isLoopbackBase(v)) {
    out(`Kickbacks: refusing non-loopback HTTP base "${v}". `
      + `Set KICKBACKS_BASE (or ~/.vibe-ads/config.json) to an https:// URL.`);
    return "https://invalid.example.invalid";
  }
  return v;
}

/** Authed-only portfolio fetch with one refresh-on-null retry. Unlike the
 *  extension's fetchPortfolioWithDemoFallback, the CLI never falls back to the
 *  signed-out DEMO portfolio: demo impressions credit no user, so serving them
 *  in someone's terminal would be ads-for-nothing. A dead token → serve nothing
 *  this tick (the daemon prints a re-login hint elsewhere). */
async function fetchAuthedPortfolio(
  portfolio: PortfolioClient, auth: CliAuth, ccVersion: string,
): Promise<PortfolioResponse | null> {
  const r = await portfolio.fetchPortfolio(ccVersion, "");
  if (r) return r;
  const refreshed = await auth.refresh();
  if (refreshed) return portfolio.fetchPortfolio(ccVersion, "");
  return null;
}

function cliSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}
function cliBackupPath(): string {
  return cliSettingsPath() + ".vibe-ads-backup";
}
/** Key-scoped removal of our statusLine/spinnerVerbs (restoring any captured
 *  user HUD) + cleanup of the script/cache. Never throws. */
function restoreStatusline(): void {
  try { new ClaudeCliStatuslineAdapter(cliSettingsPath()).restore(); }
  catch { /* best-effort */ }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<number> {
  const auth = new CliAuth({ base: resolveBase() });
  await auth.loadCached();
  if (auth.signedIn()) { out("Already signed in to Kickbacks."); return 0; }
  const ok = await auth.signIn();
  if (ok) { out("\n✓ Signed in. Run `kickbacks start` to begin earning."); return 0; }
  return 1;
}

async function cmdLogout(): Promise<number> {
  const auth = new CliAuth({ base: resolveBase() });
  await auth.signOut();
  restoreStatusline();   // a signed-out machine must serve nothing
  out("✓ Signed out and removed any Kickbacks statusline.");
  return 0;
}

async function cmdStatus(): Promise<number> {
  const base = resolveBase();
  const auth = new CliAuth({ base });
  await auth.loadCached();
  out(`Kickbacks CLI ${buildVersion()}`);
  out(`  Backend:   ${base}`);
  out(`  Signed in: ${auth.signedIn() ? "yes" : "no"}`);
  out(`  Storage:   ${auth.storageScheme()}`);
  out(`  Statusline installed: ${existsSync(cliBackupPath()) ? "yes" : "no"}`);
  if (auth.signedIn()) {
    const ccVersion = (await resolveCcVersion()).label;
    out(`  Claude CLI: ${ccVersion}`);
    const portfolio = new PortfolioClient(base, () => auth.accessToken());
    const r = await fetchAuthedPortfolio(portfolio, auth, ccVersion);
    if (r?.balances) {
      out(`  Earnings:  $${r.balances.todayUsd} today · $${r.balances.lifetimeUsd} lifetime`);
    }
  } else {
    out("\nRun `kickbacks login` to start.");
  }
  return 0;
}

async function cmdRestore(): Promise<number> {
  restoreStatusline();
  out("✓ Removed Kickbacks from your Claude Code statusline (your settings.json is untouched otherwise).");
  return 0;
}

async function cmdStart(): Promise<number> {
  const base = resolveBase();
  const auth = new CliAuth({ base });
  await auth.loadCached();
  if (!auth.signedIn()) {
    out("Not signed in. Run `kickbacks login` first.");
    return 1;
  }

  const cc = await resolveCcVersion();
  const ccVersion = cc.label;
  const portfolio = new PortfolioClient(base, () => auth.accessToken());
  const metrics = new MetricsClient(base, () => auth.accessToken(),
    () => auth.clientId(), buildVersion(), undefined, cliClientEnv());
  const kill = new KillSwitchClient(base);
  const surface = new CliSurface({ metrics, ccVersion });
  // spinnerVerbs render+billing gate, resolved synchronously from the same
  // version probe (CC >= 2.1.143). Fail-open on an undetectable version.
  surface.setSpinnerSupport(cc.spinnerOk);

  let ad: PatchAd | null = null;
  let killed = false;
  const adRef = { get current(): PatchAd | null { return ad; },
                  set current(v: PatchAd | null) { ad = v; } };
  const killedRef = { get current(): boolean { return killed; },
                      set current(v: boolean) { killed = v; } };

  const timers: NodeJS.Timeout[] = [];

  const syncTick = async (): Promise<void> => {
    try {
      if (killed) { surface.restore(); return; }
      const r = await fetchAuthedPortfolio(portfolio, auth, ccVersion);
      ad = r?.ad ?? null;
      if (ad && auth.accessToken()) surface.apply(ad);
      else surface.restore();
    } catch { /* never break the loop */ }
  };

  const killTick = async (): Promise<void> => {
    try {
      const ks = await kill.checkOnce(ccVersion, ad?.campaignId || "");
      // CONFIRMED kill → restore + halt writers. OFFLINE (killed && !confirmed)
      // → freeze: leave the on-disk state as-is, no churn. RECOVERY → resume.
      if (ks.killed && ks.confirmed) { killed = true; surface.restore(); }
      else if (!ks.killed) killed = false;
    } catch { /* ignore */ }
  };

  await syncTick();
  await killTick();
  timers.push(setInterval(() => void syncTick(), 60_000));
  timers.push(setInterval(() => void killTick(), 30_000));

  // Billing: reuse the extension's exact view-tick loop. cliMode is forced on
  // (the user explicitly started the daemon) and the kill posture is fed via
  // canPatchFn so a confirmed kill stops ticking without touching the globals.
  const cliTail = new LogTail(locateClaudeCliLog);
  setupCliTick({
    cliTail, metrics, adRef, killedRef,
    signedIn: () => !!auth.accessToken(),
    surfaceApplied: () => {
      try { return surface.adapter.preflight().compatible; } catch { return false; }
    },
    ccVersion, timers,
    cliModeFn: () => "on",
    canPatchFn: () => !killed,
  });

  out(`✓ Kickbacks is running (claude ${ccVersion}).`);
  out(`  Ads appear in your \`claude\` statusline + spinner while you work;`);
  out(`  earnings accrue at https://kickbacks.ai. Press Ctrl-C to stop.`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    for (const t of timers) clearInterval(t);
    surface.restore();
    out("\nStopped. Your Claude Code statusline has been restored.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the event loop alive; the timers above drive all work.
  await new Promise<void>(() => { /* until a signal calls process.exit */ });
  return 0;
}

const HELP = `kickbacks — earn from Claude Code ads in your terminal (no VS Code needed)

Usage:
  kickbacks login      Sign in with Google (shared with the VS Code extension)
  kickbacks start      Run the daemon: show ads in the claude statusline + earn
  kickbacks status     Show sign-in state, install state, and balance
  kickbacks restore    Remove the Kickbacks statusline from ~/.claude/settings.json
  kickbacks logout     Sign out and remove the statusline
  kickbacks help       Show this help

It writes only the official statusLine + spinnerVerbs keys in
~/.claude/settings.json (any existing statusline HUD is preserved and chained).
Stop the daemon, run \`kickbacks restore\`, or sign out to remove it.`;

/** Map argv to a command name. Exported for tests. */
export function parseCommand(argv: string[]): string {
  const first = argv.find((a) => !a.startsWith("-"));
  const cmd = (first || "help").toLowerCase();
  if (cmd === "run") return "start";
  if (cmd === "uninstall") return "restore";
  if (cmd === "signin") return "login";
  if (cmd === "signout") return "logout";
  if (cmd === "-h" || cmd === "--help") return "help";
  return cmd;
}

export async function run(argv: string[]): Promise<number> {
  const cmd = parseCommand(argv);
  switch (cmd) {
    case "login":   return cmdLogin();
    case "logout":  return cmdLogout();
    case "status":  return cmdStatus();
    case "start":   return cmdStart();
    case "restore": return cmdRestore();
    case "help":    out(HELP); return 0;
    default:
      out(`Unknown command: ${cmd}\n`);
      out(HELP);
      return 1;
  }
}

// Only execute when invoked directly (not when imported by tests).
if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      out("kickbacks: " + (e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    });
}
