import { execFile } from "node:child_process";
import { parseClaudeCliVersion, supportsSpinnerVerbs, type SemVer }
  from "../adapters/claude-cli/cliVersion";

// Windows-aware `claude --version` probe.
//
// The shared detectClaudeCliVersion (adapters/claude-cli/cliVersion.ts) calls
// execFile("claude", ...) with NO shell. On Windows the user's `claude` is a
// `.cmd` shim, and execFile bypasses PATHEXT/cmd resolution, so it ENOENTs and
// the version comes back null — which makes the CLI report
// claude_code_version:"cli" to the backend instead of the real semver (the
// backend uses that field for killswitch scoping + crediting). We pass
// shell:true ONLY on win32 so the shim resolves; on POSIX we keep shell:false
// (no shell-injection surface — `claude` is the only token and there is no
// untrusted input). Never throws.

export function detectClaudeVersion(): Promise<SemVer | null> {
  return new Promise((res) => {
    try {
      execFile("claude", ["--version"],
        { timeout: 4000, windowsHide: true, shell: process.platform === "win32" },
        (err, stdout) => {
          if (err) return res(null);
          res(parseClaudeCliVersion(String(stdout ?? "")));
        });
    } catch { res(null); }
  });
}

export interface CcVersionInfo {
  /** The terminal claude semver as "2.1.165", or "cli" when undetectable. */
  label: string;
  /** Whether to write + bill the spinnerVerbs surface. Fail-OPEN on null
   *  (assume support when undetectable) so a flaked probe still renders the
   *  verb; the billing gate stays separately guarded in CliSurface. */
  spinnerOk: boolean;
}

/** Pure label/support derivation — split out so it is unit-testable without
 *  spawning a real `claude`. */
export function formatCcVersion(v: SemVer | null): CcVersionInfo {
  return {
    label: v ? `${v[0]}.${v[1]}.${v[2]}` : "cli",
    spinnerOk: v === null ? true : supportsSpinnerVerbs(v),
  };
}

export async function resolveCcVersion(): Promise<CcVersionInfo> {
  return formatCcVersion(await detectClaudeVersion());
}
