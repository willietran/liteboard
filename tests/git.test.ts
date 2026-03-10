import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

import { execFileSync } from "node:child_process";
import { git } from "../src/git.js";

const mockExec = vi.mocked(execFileSync);

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
});

// ─── git helper ─────────────────────────────────────────────────────────────

describe("git", () => {
  it("executes git command with correct args", () => {
    git(["status", "--short"]);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["status", "--short"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("passes cwd option to execFileSync", () => {
    git(["log"], { cwd: "/some/path" });

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["log"],
      expect.objectContaining({ cwd: "/some/path", encoding: "utf-8" }),
    );
  });

  it("logs to stderr when verbose is true", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    git(["branch", "-a"], { verbose: true });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("git branch -a"),
    );
    spy.mockRestore();
  });

  it("does not log when verbose is false", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    git(["branch", "-a"], { verbose: false });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("captures stderr on failure and includes it in the error message", () => {
    mockExec.mockImplementation(() => {
      const err = new Error("git failed") as Error & { stderr: string };
      err.stderr = "fatal: not a git repository";
      throw err;
    });

    expect(() => git(["status"])).toThrow(/fatal: not a git repository/);
  });

  it("falls back to error.message when stderr is empty", () => {
    mockExec.mockImplementation(() => {
      throw new Error("command not found");
    });

    expect(() => git(["status"])).toThrow(/command not found/);
  });
});
