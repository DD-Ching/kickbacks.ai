import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSurface } from "../src/cli/sync";
import type { PatchAd } from "../src/portfolio/client";
import type { MetricsClient } from "../src/metrics/client";

// CliSurface is the vscode-free port of cliSync's write path. These tests drive
// it against a tmp settings.json with a recording metrics stub and an injected
// session-active probe, so impression attribution is deterministic.

function ad(id = "ad1"): PatchAd {
  return { adId: id, campaignId: "c1", adText: "Acme — try Acme.com",
    iconRef: "i", iconUrl: "", clickUrl: "https://acme/x",
    bannerEnabled: false, sessionToken: "tok-" + id };
}

interface Call { event: string; surface?: string; adId: string }
function recorder(): { calls: Call[]; send: MetricsClient["send"] } {
  const calls: Call[] = [];
  const send: MetricsClient["send"] = async (event, a) => {
    calls.push({ event, surface: a.surface, adId: a.adId });
  };
  return { calls, send };
}

function home(): { home: string; settings: string } {
  const h = mkdtempSync(join(tmpdir(), "kb-cli-sync-"));
  mkdirSync(join(h, ".claude"), { recursive: true });
  const settings = join(h, ".claude", "settings.json");
  writeFileSync(settings, '{\n  "model": "opus"\n}\n');
  return { home: h, settings };
}
function surfaces(calls: Call[], surface: string): string[] {
  return calls.filter((c) => c.surface === surface).map((c) => c.event);
}

describe("CliSurface.apply", () => {
  it("writes the official statusLine + spinnerVerbs keys, preserving other keys", () => {
    const { home: h, settings } = home();
    const rec = recorder();
    const s = new CliSurface({ metrics: rec, ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => true });
    s.apply(ad());
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.statusLine.type).toBe("command");
    expect(parsed.statusLine.command).toContain("vibe-ads-statusline.mjs");
    expect(parsed.spinnerVerbs.verbs).toEqual(["Acme — try Acme.com"]);
    expect(parsed.model).toBe("opus");
  });

  it("emits exactly one statusline impression pair per ad", () => {
    const { home: h, settings } = home();
    const rec = recorder();
    const s = new CliSurface({ metrics: rec, ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => true });
    s.apply(ad());
    expect(surfaces(rec.calls, "statusline"))
      .toEqual(["impression_rendered", "impression_viewable"]);
  });

  it("does NOT bill the spinner verb until support is confirmed, then does", () => {
    const { home: h, settings } = home();
    const rec = recorder();
    const s = new CliSurface({ metrics: rec, ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => true });
    s.apply(ad("a1"));
    expect(surfaces(rec.calls, "spinner")).toEqual([]);          // gated off pre-detection
    s.setSpinnerSupport(true);
    s.apply(ad("a2"));                                            // new adId
    expect(surfaces(rec.calls, "spinner"))
      .toEqual(["impression_rendered", "impression_viewable"]);
  });

  it("dedups: re-applying the same ad emits no new impressions", () => {
    const { home: h, settings } = home();
    const rec = recorder();
    const s = new CliSurface({ metrics: rec, ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => true });
    s.apply(ad("same"));
    const n = rec.calls.length;
    s.apply(ad("same"));
    expect(rec.calls.length).toBe(n);
  });

  it("writes the ad but bills NOTHING when no CLI session is active", () => {
    const { home: h, settings } = home();
    const rec = recorder();
    const s = new CliSurface({ metrics: rec, ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => false });
    s.apply(ad());
    expect(rec.calls).toEqual([]);                               // no impression billed
    expect(readFileSync(settings, "utf8")).toContain('"statusLine"'); // ad still written
  });

  it("no-ops on an unparseable settings.json (never corrupts it)", () => {
    const { home: h, settings } = home();
    writeFileSync(settings, "{ broken ");
    const rec = recorder();
    const s = new CliSurface({ metrics: rec, ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => true });
    s.apply(ad());
    expect(rec.calls).toEqual([]);
    expect(readFileSync(settings, "utf8")).toBe("{ broken ");
  });
});

describe("CliSurface.restore", () => {
  it("removes our keys and restores the file byte-exact", () => {
    const { home: h, settings } = home();
    const pristine = readFileSync(settings, "utf8");
    const s = new CliSurface({ metrics: recorder(), ccVersion: "2.1.158",
      settingsPath: settings, home: h, sessionActiveFn: () => true });
    s.apply(ad());
    expect(readFileSync(settings, "utf8")).toContain('"statusLine"');
    s.restore();
    expect(readFileSync(settings, "utf8")).toBe(pristine);
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(false);
  });
});
