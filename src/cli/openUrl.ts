// Cross-platform "open this URL in the user's browser" for the standalone CLI.
// The VS Code extension uses vscode.env.openExternal; outside VS Code we shell
// out to the platform opener. Best-effort and NEVER throws — the sign-in flow
// always prints the URL first, so a missing opener degrades to copy/paste.

import { spawn } from "node:child_process";

export function openUrl(url: string): void {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd built-in. The empty "" is the (ignored) window title.
      // CRITICAL: cmd parses `&` as a command separator, and OAuth sign-in URLs
      // are full of `&` (…&state=…) — an unescaped URL opens TRUNCATED. Escape
      // `&` → `^&` and pass the args verbatim (windowsVerbatimArguments) so cmd
      // receives the literal caret-escaped URL. This is the long-proven
      // approach used by the `open`/`opn` packages.
      const child = spawn("cmd",
        ["/c", "start", '""', "/b", url.replace(/&/g, "^&")],
        { stdio: "ignore", detached: true, windowsVerbatimArguments: true });
      child.on("error", () => { /* opener absent — the URL was already printed */ });
      child.unref();
      return;
    }
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => { /* opener absent — the URL was already printed */ });
    child.unref();
  } catch { /* never throw: the caller printed the URL for manual paste */ }
}
