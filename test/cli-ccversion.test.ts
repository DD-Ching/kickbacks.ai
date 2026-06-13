import { describe, it, expect } from "vitest";
import { formatCcVersion } from "../src/cli/ccVersion";

// formatCcVersion is the pure label/support derivation (the spawn itself is
// covered by the live `resolveCcVersion`, which can't run hermetically). The
// Windows `.cmd`-shim spawn fix (shell:true on win32) is verified manually;
// here we lock the version→label/spinner mapping the backend depends on.

describe("formatCcVersion", () => {
  it("formats a detected semver into a dotted label", () => {
    expect(formatCcVersion([2, 1, 165]).label).toBe("2.1.165");
  });
  it("falls back to \"cli\" when the version is undetectable (null)", () => {
    expect(formatCcVersion(null).label).toBe("cli");
  });
  it("enables the spinner surface on CC >= 2.1.143", () => {
    expect(formatCcVersion([2, 1, 165]).spinnerOk).toBe(true);
    expect(formatCcVersion([2, 1, 143]).spinnerOk).toBe(true);
  });
  it("disables the spinner surface on a positively-old CC (< 2.1.143)", () => {
    expect(formatCcVersion([2, 1, 142]).spinnerOk).toBe(false);
    expect(formatCcVersion([2, 0, 44]).spinnerOk).toBe(false);
  });
  it("fail-opens the spinner surface when the version is unknown (null)", () => {
    // A flaked probe must still render the verb; billing stays guarded in
    // CliSurface, so an unknown version never bills an unrendered spinner.
    expect(formatCcVersion(null).spinnerOk).toBe(true);
  });
});
