import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createVault, type SecretVault } from "../auth/vault";
import { timeoutFetch } from "../util/http";
import { openUrl as defaultOpenUrl } from "./openUrl";

// The vscode-free auth client for the standalone CLI. It speaks the SAME S1
// backend protocol as the extension's AuthClient (/v1/auth/extension/start →
// /poll, /v1/auth/refresh, /v1/auth/signout) and persists to the SAME universal
// floor file the extension treats as its durable source of truth:
//
//   ~/.kickbacks/auth.json   { "refresh": "<sealed-envelope>", "clientId": "…" }
//
// sealed via the SAME pure-Node SecretVault (Keychain / DPAPI / libsecret /
// plaintext floor) under the SAME service+account. The practical payoff: a user
// who signed in through the VS Code extension is ALREADY signed in on the CLI
// (and vice versa) — one session, both surfaces. The only thing the extension's
// AuthClient does that we deliberately drop is the VS Code SecretStorage cache
// (it is "never the source of truth" — see auth/client.ts), which is exactly
// the layer that does not exist outside VS Code.

type Fetch = typeof fetch;

// A vault-sealed value; anything NOT matching is a pre-vault plaintext token
// written by an older build (used as-is, then re-sealed on next persist).
const ENVELOPE = /^(plain|keychain|dpapi|libsecret):1:/;

interface Fallback { refresh?: string; clientId?: string }

export interface CliAuthOptions {
  base: string;
  /** Injectable for tests; defaults to the shared 15s-timeout fetch. */
  fetchImpl?: Fetch;
  /** Override the auth file location (tests). Defaults to ~/.kickbacks/auth.json. */
  authFile?: string;
  /** Legacy file read-through (migrate-on-read). Defaults to ~/.vibe-ads/auth.json. */
  legacyAuthFile?: string;
  /** Injectable secret vault (tests). Defaults to the platform vault. */
  vault?: SecretVault;
  /** How to open the sign-in URL. Defaults to the OS browser opener. */
  openUrl?: (url: string) => void;
  /** Poll cadence for the sign-in completion loop (ms). */
  pollMs?: number;
  /** Where user-facing prompts go. Defaults to stdout. */
  print?: (msg: string) => void;
}

export class CliAuth {
  private at: string | null = null;
  // Single-flight guard: S1 /refresh ROTATES (consumes) the refresh token, so
  // two concurrent refreshes race — the first rotates RT→RT2, the second sends
  // the now-consumed RT, 401s, and nulls the access token (a false sign-out).
  // The daemon's 15s fetch timeout is shorter than its 60s sync interval so
  // overlap is unlikely, but coalescing onto one in-flight request removes the
  // race entirely (mirrors AuthClient.refreshInFlight).
  private refreshInFlight: Promise<boolean> | null = null;
  private readonly base: string;
  private readonly f: Fetch;
  private readonly authFile: string;
  private readonly legacyAuthFile: string;
  private readonly vault: SecretVault;
  private readonly openUrlFn: (url: string) => void;
  private readonly pollMs: number;
  private readonly print: (msg: string) => void;

  constructor(opts: CliAuthOptions) {
    this.base = opts.base;
    this.f = opts.fetchImpl ?? timeoutFetch(15000);
    this.authFile = opts.authFile ?? join(homedir(), ".kickbacks", "auth.json");
    this.legacyAuthFile =
      opts.legacyAuthFile ?? join(homedir(), ".vibe-ads", "auth.json");
    this.vault = opts.vault ?? createVault(process.platform);
    this.openUrlFn = opts.openUrl ?? defaultOpenUrl;
    this.pollMs = opts.pollMs ?? 1500;
    this.print = opts.print ?? ((m) => { try { process.stdout.write(m + "\n"); } catch { /* ignore */ } });
  }

  accessToken(): string | null { return this.at; }
  signedIn(): boolean { return this.at != null; }
  storageScheme(): string { return this.vault.scheme(); }

  // --- id-independent file (best-effort; never throws) ---------------------
  private readFallback(): Fallback {
    try { return JSON.parse(readFileSync(this.authFile, "utf8")) as Fallback; }
    catch { /* fall through to legacy */ }
    try { return JSON.parse(readFileSync(this.legacyAuthFile, "utf8")) as Fallback; }
    catch { return {}; }
  }

  private writeFallback(patch: Fallback): void {
    try {
      const merged = { ...this.readFallback(), ...patch };
      mkdirSync(join(this.authFile, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(this.authFile, JSON.stringify(merged), { mode: 0o600 });
      try { chmodSync(this.authFile, 0o600); } catch { /* best-effort */ }
    } catch { /* persistence is best-effort; never break the CLI */ }
  }

  /** Stable anonymous device id (NOT auth). Shared with the extension via the
   *  file's `clientId`; minted + persisted here only when neither side has one. */
  clientId(): string {
    let id = this.readFallback().clientId;
    if (!id) {
      id = randomBytes(12).toString("hex");
      this.writeFallback({ clientId: id });
    }
    return id;
  }

  private async sealToFile(refresh: string): Promise<void> {
    try {
      const env = await this.vault.seal(this.clientId(), refresh);
      this.writeFallback({ refresh: env });
    } catch { /* best-effort */ }
  }

  /** Recover the raw refresh token from the sealed envelope (or a legacy
   *  plaintext value), or null when none is recoverable. */
  private async readRefreshToken(): Promise<string | null> {
    const stored = this.readFallback().refresh;
    if (!stored) return null;
    if (ENVELOPE.test(stored)) return (await this.vault.open(stored)) || null;
    return stored; // pre-vault plaintext token from an older build
  }

  /** Re-mint the access token from the durable refresh token. Mirrors
   *  AuthClient.refresh's posture: an EXPLICIT 401/403 clears the session;
   *  a transient failure (network/5xx) keeps the token so a later tick retries.
   *  Persists the rotated refresh token (S1 consumes + reissues). */
  async loadCached(): Promise<void> {
    const rt = await this.readRefreshToken();
    if (rt) await this.refresh(rt);
  }

  async refresh(explicitRt?: string): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = this._refresh(explicitRt);
    this.refreshInFlight = p;
    try { return await p; }
    finally { if (this.refreshInFlight === p) this.refreshInFlight = null; }
  }

  private async _refresh(explicitRt?: string): Promise<boolean> {
    try {
      const rt = explicitRt ?? (await this.readRefreshToken());
      if (!rt) { this.at = null; return false; }
      const r = await this.f(`${this.base}/v1/auth/refresh`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) {
        // Only an explicit rejection (the server saw the token and refused it)
        // ends the session; 5xx/429/gateway noise is transient — keep the token.
        if (r.status === 401 || r.status === 403) this.at = null;
        return false;
      }
      const j = await r.json() as { access_token?: string; refresh_token?: string };
      if (!j.access_token) return false; // 2xx w/o token: proxy anomaly, keep token
      this.at = j.access_token;
      if (j.refresh_token) await this.sealToFile(j.refresh_token);
      return true;
    } catch {
      // Network/DNS/timeout: transient — keep the current tokens.
      return false;
    }
  }

  /** Interactive sign-in: open the backend-brokered Google consent URL and poll
   *  for the minted tokens. Same /extension/start → /poll contract as the
   *  extension; the only difference is the OS browser opener + stdout prompt in
   *  place of vscode.env.openExternal. */
  async signIn(): Promise<boolean> {
    try {
      const start = await this.f(`${this.base}/v1/auth/extension/start`,
        { redirect: "manual" } as RequestInit);
      const loc = start.headers.get("location");
      if (!loc) { this.print("Sign-in failed: backend returned no auth URL."); return false; }
      const state = new URL(loc).searchParams.get("state");
      if (!state) { this.print("Sign-in failed: no state in the auth URL."); return false; }
      this.print("\nTo sign in with Google, open this URL in your browser:\n");
      this.print("  " + loc + "\n");
      try { this.openUrlFn(loc); } catch { /* user can copy/paste the URL above */ }
      this.print("Waiting for you to finish in the browser…");
      for (let i = 0; i < 120; i++) {
        const r = await this.f(
          `${this.base}/v1/auth/extension/poll?state=${encodeURIComponent(state)}`);
        const j = await r.json().catch(() => ({})) as
          { access_token?: string; refresh_token?: string };
        if (j.access_token) {
          this.at = j.access_token;
          if (j.refresh_token) await this.sealToFile(j.refresh_token);
          return true;
        }
        await new Promise((res) => setTimeout(res, this.pollMs));
      }
      this.print("Sign-in timed out. Did you complete the Google consent?");
      return false;
    } catch (e) {
      this.print("Sign-in failed: " + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /** Full sign-out: revoke server-side (best-effort, fire-and-forget so it works
   *  offline), clear any OS-store-held secret, and wipe the refresh field from
   *  the file while KEEPING the anonymous clientId (device id, not auth). */
  async signOut(): Promise<void> {
    const rt = await this.readRefreshToken();
    this.at = null;
    if (rt) {
      try {
        void this.f(`${this.base}/v1/auth/signout`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        }).catch(() => { /* revocation is defense-in-depth; never block */ });
      } catch { /* never block sign-out */ }
    }
    const env = this.readFallback().refresh;
    if (env && ENVELOPE.test(env)) {
      try { await this.vault.clear(env); } catch { /* best-effort */ }
    }
    try {
      const fb = this.readFallback();
      delete fb.refresh;               // keep clientId
      mkdirSync(join(this.authFile, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(this.authFile, JSON.stringify(fb), { mode: 0o600 });
      try { chmodSync(this.authFile, 0o600); } catch { /* best-effort */ }
    } catch { /* mirror clear is best-effort */ }
  }
}
