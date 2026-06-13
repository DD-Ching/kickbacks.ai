import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVault } from "../src/auth/vault";
import { CliAuth } from "../src/cli/vaultAuth";

// The CLI auth reuses the pure-Node SecretVault + the same ~/.kickbacks/auth.json
// the extension treats as its durable source of truth. Tests use the PLAINTEXT
// vault (an unknown platform string resolves to the `plain:1:<secret>` floor)
// and an injected fetch, so they run hermetically with no keychain or network.

const BASE = "https://example.test";
const plainVault = () => createVault("test-plain"); // unknown platform => plaintext
const noFetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

function tmpAuthFile(): string {
  return join(mkdtempSync(join(tmpdir(), "kb-cli-auth-")), "auth.json");
}
function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj),
    { status, headers: { "content-type": "application/json" } });
}
function readFile(p: string): { refresh?: string; clientId?: string } {
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("CliAuth.clientId", () => {
  it("mints once, persists to the file, and is stable across instances", () => {
    const authFile = tmpAuthFile();
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl: noFetch });
    const id = a.clientId();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(readFile(authFile).clientId).toBe(id);
    const b = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl: noFetch });
    expect(b.clientId()).toBe(id);            // shared device id, not regenerated
  });
});

describe("CliAuth.refresh", () => {
  it("mints an access token from the stored refresh token and persists the rotation", async () => {
    const authFile = tmpAuthFile();
    // Simulate what the extension wrote: a plaintext-sealed refresh token.
    writeFileSync(authFile, JSON.stringify({ refresh: "plain:1:RT1", clientId: "dev1" }));
    let sentRt: string | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/v1/auth/refresh")) {
        sentRt = JSON.parse(String(init?.body)).refresh_token;
        return jsonResp({ access_token: "AT1", refresh_token: "RT2" });
      }
      return jsonResp({}, 404);
    }) as typeof fetch;
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl });
    expect(await a.refresh()).toBe(true);
    expect(a.accessToken()).toBe("AT1");
    expect(a.signedIn()).toBe(true);
    expect(sentRt).toBe("RT1");
    expect(readFile(authFile).refresh).toBe("plain:1:RT2");   // rotated token persisted
  });

  it("loadCached re-mints from the stored token", async () => {
    const authFile = tmpAuthFile();
    writeFileSync(authFile, JSON.stringify({ refresh: "plain:1:RTx" }));
    const fetchImpl = (async () => jsonResp({ access_token: "ATx" })) as typeof fetch;
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl });
    await a.loadCached();
    expect(a.signedIn()).toBe(true);
    expect(a.accessToken()).toBe("ATx");
  });

  it("clears the session on an explicit 401 rejection", async () => {
    const authFile = tmpAuthFile();
    writeFileSync(authFile, JSON.stringify({ refresh: "plain:1:RTdead" }));
    const fetchImpl = (async () => jsonResp({ error: "invalid" }, 401)) as typeof fetch;
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl });
    expect(await a.refresh()).toBe(false);
    expect(a.signedIn()).toBe(false);
  });

  it("KEEPS the stored token on a transient 5xx (never discards on a flap)", async () => {
    const authFile = tmpAuthFile();
    writeFileSync(authFile, JSON.stringify({ refresh: "plain:1:RTkeep" }));
    const fetchImpl = (async () => jsonResp({}, 503)) as typeof fetch;
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl });
    expect(await a.refresh()).toBe(false);
    expect(readFile(authFile).refresh).toBe("plain:1:RTkeep");  // not wiped
  });

  it("returns false when no refresh token exists anywhere", async () => {
    const a = new CliAuth({ base: BASE, authFile: tmpAuthFile(),
      vault: plainVault(), fetchImpl: noFetch });
    expect(await a.refresh()).toBe(false);
    expect(a.signedIn()).toBe(false);
  });
});

describe("CliAuth.signIn", () => {
  it("opens the brokered URL, polls, and persists the minted session", async () => {
    const authFile = tmpAuthFile();
    let opened = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v1/auth/extension/start")) {
        return new Response(null, { status: 307,
          headers: { location: "https://accounts.example/o?state=ST123" } });
      }
      if (u.includes("/v1/auth/extension/poll")) {
        return jsonResp({ access_token: "ATlogin", refresh_token: "RTlogin" });
      }
      return jsonResp({}, 404);
    }) as typeof fetch;
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl,
      openUrl: (url) => { opened = url; }, pollMs: 1, print: () => { /* quiet */ } });
    expect(await a.signIn()).toBe(true);
    expect(a.accessToken()).toBe("ATlogin");
    expect(opened).toContain("state=ST123");
    expect(readFile(authFile).refresh).toBe("plain:1:RTlogin");
  });

  it("fails gracefully when the backend returns no auth URL", async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const a = new CliAuth({ base: BASE, authFile: tmpAuthFile(), vault: plainVault(),
      fetchImpl, print: () => { /* quiet */ } });
    expect(await a.signIn()).toBe(false);
  });
});

describe("CliAuth.signOut", () => {
  it("wipes the refresh token but KEEPS the anonymous clientId", async () => {
    const authFile = tmpAuthFile();
    writeFileSync(authFile, JSON.stringify({ refresh: "plain:1:RT", clientId: "keepme" }));
    const a = new CliAuth({ base: BASE, authFile, vault: plainVault(), fetchImpl: noFetch });
    await a.signOut();
    const fb = readFile(authFile);
    expect(fb.refresh).toBeUndefined();
    expect(fb.clientId).toBe("keepme");
    expect(a.signedIn()).toBe(false);
  });
});
