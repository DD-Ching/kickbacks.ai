import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCliStatuslineAdapter } from "../adapters/claude-cli/adapter";
import { writeCliAdCache, cliSessionActive, shouldCountCliImpression,
         shouldCountSpinnerImpression, FRESH_MS }
  from "../adapters/claude-cli/cliAd";
import type { PatchAd } from "../portfolio/client";
import type { MetricsClient } from "../metrics/client";

// The CLI surface writer: the vscode-free port of cliSync.ts's `syncCli` write
// path. It owns the two terminal surfaces the ClaudeCliStatuslineAdapter writes
// into ~/.claude/settings.json — the OSC 8 clickable statusLine and the
// spinnerVerbs thinking-shimmer verb — plus the one-impression-per-ad
// attribution for each (deduped on its own counter, exactly as the extension
// does). The dwell/billing loop (view_tick) is NOT here: the standalone host
// reuses the extension's own setupCliTick unchanged.

export interface CliSurfaceDeps {
  /** Only `send` is used; typed as a slice so tests can pass a recorder. */
  metrics: Pick<MetricsClient, "send">;
  /** The claude_code_version label stamped on every beacon (CLI semver or "cli"). */
  ccVersion: string;
  /** Override the settings.json path (tests). Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
  /** Override $HOME for the ~/.vibe-ads ad cache (tests). */
  home?: string;
  /** Live "is a terminal `claude` session plausibly active?" probe — gates
   *  impression billing so we never bill for a surface nobody is looking at.
   *  Defaults to the same transcript-mtime signal the extension uses. */
  sessionActiveFn?: () => boolean;
}

export class CliSurface {
  readonly adapter: ClaudeCliStatuslineAdapter;
  private readonly home: string;
  private readonly metrics: Pick<MetricsClient, "send">;
  private readonly ccVersion: string;
  private readonly sessionActiveFn: () => boolean;
  private lastCliAdId: string | null = null;
  private lastSpinnerAdId: string | null = null;

  /** Billing gate for the spinner-verb surface: true ONLY once `claude
   *  --version` has positively confirmed spinnerVerbs support (CC >= 2.1.143).
   *  Distinct from the adapter's fail-open RENDER flag (default true) — billing
   *  must wait for confirmation so we never count an unrendered verb. */
  private spinnerCountable = false;

  constructor(deps: CliSurfaceDeps) {
    this.home = deps.home ?? homedir();
    this.metrics = deps.metrics;
    this.ccVersion = deps.ccVersion;
    this.sessionActiveFn = deps.sessionActiveFn
      ?? (() => cliSessionActive(Date.now(), FRESH_MS));
    this.adapter = new ClaudeCliStatuslineAdapter(
      deps.settingsPath ?? join(this.home, ".claude", "settings.json"));
  }

  /** Reconcile the adapter's spinnerVerbs RENDER flag and our billing gate with
   *  the detected CLI support. Until this resolves the adapter writes the verb
   *  optimistically (fail-open) but billing stays off. */
  setSpinnerSupport(ok: boolean): void {
    this.adapter.spinnerVerbsSupported = ok;
    this.spinnerCountable = ok;
  }

  /** Write the current ad to both terminal surfaces and emit the
   *  one-per-ad impression pair for each (statusline + spinner), deduped.
   *  No-op when the local settings.json is unparseable (preflight gate). */
  apply(ad: PatchAd): void {
    const pf = this.adapter.preflight();
    if (!pf.compatible) return;
    this.adapter.applyPatch({ tier: 0, adText: ad.adText, iconRef: ad.iconRef,
      iconUrl: ad.iconUrl, clickToken: "", clickUrl: ad.clickUrl,
      corr: "cli." + ad.adId, loopbackPort: 0, loopbackToken: "", loopbackBase: "" });
    writeCliAdCache(this.home, { adText: ad.adText, iconRef: ad.iconRef,
      iconUrl: ad.iconUrl, clickUrl: ad.clickUrl });

    const sessionActive = this.sessionActiveFn();
    if (shouldCountCliImpression({ signedIn: true, haveAd: true, sessionActive,
        adId: ad.adId, lastCountedAdId: this.lastCliAdId })) {
      this.lastCliAdId = ad.adId;
      const corr = "cli." + ad.adId;
      void this.metrics.send("impression_rendered", { adId: ad.adId,
        campaignId: ad.campaignId, ccVersion: this.ccVersion, corr,
        surface: "statusline" });
      void this.metrics.send("impression_viewable", { adId: ad.adId,
        campaignId: ad.campaignId, ccVersion: this.ccVersion, corr,
        surface: "statusline", sessionToken: ad.sessionToken });
    }
    if (shouldCountSpinnerImpression({ supportConfirmed: this.spinnerCountable,
        signedIn: true, haveAd: true, sessionActive,
        adId: ad.adId, lastCountedAdId: this.lastSpinnerAdId })) {
      this.lastSpinnerAdId = ad.adId;
      const corr = "spinner." + ad.adId;
      void this.metrics.send("impression_rendered", { adId: ad.adId,
        campaignId: ad.campaignId, ccVersion: this.ccVersion, corr,
        surface: "spinner" });
      void this.metrics.send("impression_viewable", { adId: ad.adId,
        campaignId: ad.campaignId, ccVersion: this.ccVersion, corr,
        surface: "spinner", sessionToken: ad.sessionToken });
    }
  }

  /** Key-scoped restore: removes our statusLine/spinnerVerbs (putting back any
   *  captured user HUD) and deletes the ad cache + script. Never throws. */
  restore(): void {
    try { this.adapter.restore(); } catch { /* best-effort */ }
  }
}
