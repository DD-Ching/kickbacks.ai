import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/cli/main";

describe("parseCommand", () => {
  it("defaults to help with no args", () => {
    expect(parseCommand([])).toBe("help");
  });
  it("passes through the canonical commands", () => {
    for (const c of ["login", "logout", "status", "start", "restore", "help"]) {
      expect(parseCommand([c])).toBe(c);
    }
  });
  it("maps aliases to their canonical command", () => {
    expect(parseCommand(["run"])).toBe("start");
    expect(parseCommand(["uninstall"])).toBe("restore");
    expect(parseCommand(["signin"])).toBe("login");
    expect(parseCommand(["signout"])).toBe("logout");
  });
  it("treats -h / --help as help", () => {
    expect(parseCommand(["-h"])).toBe("help");
    expect(parseCommand(["--help"])).toBe("help");
  });
  it("is case-insensitive and skips leading flags", () => {
    expect(parseCommand(["STATUS"])).toBe("status");
    expect(parseCommand(["--verbose", "start"])).toBe("start");
  });
});
