import { release } from "node:os";

/** Client-environment fingerprint sent on every metrics beacon — the standalone
 *  CLI mirror of extension.ts::clientEnv. Transparent and minimal
 *  (os/arch/os_version/editor); the `editor` field is set to "kickbacks-cli" so
 *  the backend can segment terminal-CLI traffic from VS Code traffic. Nothing
 *  here is hidden or obfuscated. */
export function cliClientEnv(): Record<string, unknown> {
  try {
    return {
      os: process.platform,    // win32 / darwin / linux
      arch: process.arch,      // x64 / arm64
      os_version: release(),   // e.g. "10.0.26200"
      editor: "kickbacks-cli",
    };
  } catch { return { editor: "kickbacks-cli" }; }
}
