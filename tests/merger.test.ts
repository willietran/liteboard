import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("../src/build-validation.js", () => ({
  runBuildValidation: vi.fn(() => ({
    success: true,
    failedPhase: "none",
    tscErrorCount: 0,
    testFailCount: 0,
    testPassCount: 0,
  })),
  NPM_TIMEOUT_MS: 120_000,
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { squashMerge, abortAndRecover } from "../src/merger.js";
import { runBuildValidation } from "../src/build-validation.js";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockRunBuildValidation = vi.mocked(runBuildValidation);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns all git calls as [command, args] tuples. */
function gitCalls(): string[][] {
  return mockExec.mock.calls
    .filter((c) => c[0] === "git")
    .map((c) => c[1] as string[]);
}

/** Returns all npm calls as [command, args] tuples. */
function npmCalls(): [string, string[]][] {
  return mockExec.mock.calls
    .filter((c) => c[0] === "npm")
    .map((c) => [c[0] as string, c[1] as string[]]);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
  mockExistsSync.mockReturnValue(true);
  mockRunBuildValidation.mockReturnValue({
    success: true,
    failedPhase: "none",
    tscErrorCount: 0,
    testFailCount: 0,
    testPassCount: 0,
  });
});

// ─── squashMerge: happy path ─────────────────────────────────────────────────

describe("squashMerge — trial merge succeeds", () => {
  it("calls runBuildValidation with cleanInstall=false", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "rev-parse" && a[1] === "--show-toplevel") {
        return "/repo/root";
      }
      return "";
    });

    await squashMerge(1, "proj", "feat/x", "chore: test", false);

    expect(mockRunBuildValidation).toHaveBeenCalledWith(
      "/repo/root",
      expect.objectContaining({ cleanInstall: false }),
    );
  });

  it("commits with the correct message after successful merge", async () => {
    await squashMerge(3, "proj", "feat/x", "feat: add widget", false);

    expect(gitCalls()).toContainEqual(["checkout", "feat/x"]);
    expect(gitCalls()).toContainEqual([
      "merge",
      "--squash",
      "--no-commit",
      "feat/x-t3",
    ]);
    expect(gitCalls()).toContainEqual(["commit", "-m", "feat: add widget"]);
  });

  it("removes ephemeral files (including .qa-report.md) from staging before commit", async () => {
    await squashMerge(5, "proj", "feat/x", "fix: stuff", false);

    expect(gitCalls()).toContainEqual(
      expect.arrayContaining([
        "reset",
        "HEAD",
        "--",
        ".memory-entry.md",
        ".brief-t5.md",
        ".qa-report.md",
      ]),
    );

    const calls = gitCalls();
    const resetIdx = calls.findIndex(
      (c) => c[0] === "reset" && c[1] === "HEAD",
    );
    const commitIdx = calls.findIndex((c) => c[0] === "commit");
    expect(resetIdx).toBeLessThan(commitIdx);
  });

  it("deletes ephemeral files from disk after unstaging", async () => {
    await squashMerge(5, "proj", "feat/x", "fix: stuff", false);

    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map(c => c[0]);
    expect(unlinkCalls).toContain(".memory-entry.md");
    expect(unlinkCalls).toContain(".brief-t5.md");
    expect(unlinkCalls).toContain(".qa-report.md");
  });

  it("stages lockfile after build validation", async () => {
    await squashMerge(9, "proj", "feat/x", "chore: lock", false);

    // Should stage package-lock.json
    expect(gitCalls()).toContainEqual(["add", "package-lock.json"]);
  });
});

// ─── squashMerge: build validation failure ───────────────────────────────────

describe("squashMerge — build validation failure", () => {
  it("aborts merge and throws when build validation fails", async () => {
    mockRunBuildValidation.mockReturnValue({
      success: false,
      failedPhase: "build",
      error: "build failed",
      stderr: "tsc error TS2304",
      tscErrorCount: 0,
      testFailCount: 0,
      testPassCount: 0,
    });

    await expect(
      squashMerge(2, "proj", "feat/x", "feat: bad", false),
    ).rejects.toThrow(/Build validation.*fail/);

    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });

  it("aborts merge and throws when type check fails", async () => {
    mockRunBuildValidation.mockReturnValue({
      success: false,
      failedPhase: "typecheck",
      error: "type check failed",
      stderr: "error TS2345",
      tscErrorCount: 1,
      testFailCount: 0,
      testPassCount: 0,
    });

    await expect(
      squashMerge(10, "proj", "feat/x", "feat: bad-types", false),
    ).rejects.toThrow(/Type check.*fail/);

    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });

  it("aborts merge and throws when test suite fails", async () => {
    mockRunBuildValidation.mockReturnValue({
      success: false,
      failedPhase: "test",
      error: "tests failed",
      stderr: "FAIL src/foo.test.ts",
      tscErrorCount: 0,
      testFailCount: 2,
      testPassCount: 10,
    });

    await expect(
      squashMerge(11, "proj", "feat/x", "feat: bad-tests", false),
    ).rejects.toThrow(/Test suite.*fail/);

    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });

  it("aborts merge and throws when install fails", async () => {
    mockRunBuildValidation.mockReturnValue({
      success: false,
      failedPhase: "install",
      error: "install failed",
      stderr: "npm ERR! code ERESOLVE",
      tscErrorCount: 0,
      testFailCount: 0,
      testPassCount: 0,
    });

    await expect(
      squashMerge(8, "proj", "feat/x", "feat: bad-deps", false),
    ).rejects.toThrow(/Dependency installation.*fail/);

    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });
});

// ─── abortAndRecover ─────────────────────────────────────────────────────────

describe("abortAndRecover", () => {
  it("runs merge --abort, checkout, and reset --hard HEAD", () => {
    abortAndRecover("feat/x", false);

    const calls = gitCalls();
    expect(calls).toContainEqual(["merge", "--abort"]);
    expect(calls).toContainEqual(["checkout", "feat/x"]);
    expect(calls).toContainEqual(["reset", "--hard", "HEAD"]);

    const abortIdx = calls.findIndex(
      (c) => c[0] === "merge" && c[1] === "--abort",
    );
    const checkoutIdx = calls.findIndex(
      (c) => c[0] === "checkout" && c[1] === "feat/x",
    );
    const resetIdx = calls.findIndex(
      (c) => c[0] === "reset" && c[1] === "--hard",
    );
    expect(abortIdx).toBeLessThan(checkoutIdx);
    expect(checkoutIdx).toBeLessThan(resetIdx);
  });
});

// ─── Merge serialization ─────────────────────────────────────────────────────

describe("squashMerge — serialization", () => {
  it("second merge waits for first to complete", async () => {
    const order: number[] = [];

    let callCount = 0;
    mockExec.mockImplementation((cmd, args) => {
      if (cmd === "git" && (args as string[])[0] === "commit") {
        callCount++;
        if (callCount === 1) {
          order.push(1);
        } else {
          order.push(2);
        }
      }
      return "";
    });

    const p1 = squashMerge(1, "proj", "feat/x", "first", false);
    const p2 = squashMerge(2, "proj", "feat/x", "second", false);

    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
  });
});

// ─── Conflict: package.json auto-resolve ─────────────────────────────────────

describe("squashMerge — package.json conflict resolution", () => {
  it("auto-resolves package.json conflicts with checkout --theirs and npm install", async () => {
    let mergeAttempt = 0;

    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "merge" && a[1] === "--squash") {
        mergeAttempt++;
        if (mergeAttempt === 1) {
          throw new Error("merge conflict");
        }
        return "";
      }
      if (
        cmd === "git" &&
        a[0] === "diff" &&
        a.includes("--diff-filter=U")
      ) {
        return "package.json\npackage-lock.json";
      }
      return "";
    });

    await squashMerge(4, "proj", "feat/x", "fix: deps", false);

    const calls = gitCalls();

    expect(calls).toContainEqual(["checkout", "--theirs", "package.json"]);
    expect(calls).toContainEqual([
      "checkout",
      "--theirs",
      "package-lock.json",
    ]);

    expect(npmCalls().some(([cmd, a]) => a[0] === "install")).toBe(true);
    expect(calls).toContainEqual(["add", "package-lock.json"]);
  });
});

// ─── squashMerge: no package.json (non-npm project) ─────────────────────────

describe("squashMerge — no package.json", () => {
  it("skips lockfile staging when no package.json", async () => {
    mockExistsSync.mockReturnValue(false);

    await squashMerge(7, "proj", "feat/x", "chore: no-npm", false);

    // runBuildValidation should have been called (it handles the no-pkg case internally)
    expect(mockRunBuildValidation).toHaveBeenCalled();

    // Commit still happens
    expect(gitCalls()).toContainEqual(["commit", "-m", "chore: no-npm"]);
  });
});

// ─── Conflict: other files → squash-rebase-retry ─────────────────────────────

describe("squashMerge — non-package conflict triggers squash-rebase-retry", () => {
  it("squashes task branch, rebases, and retries merge on non-package conflicts", async () => {
    let mergeAttempt = 0;

    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "merge" && a[1] === "--squash") {
        mergeAttempt++;
        if (mergeAttempt === 1) {
          throw new Error("merge conflict");
        }
        return "";
      }
      if (
        cmd === "git" &&
        a[0] === "diff" &&
        a.includes("--diff-filter=U")
      ) {
        return "src/index.ts";
      }
      return "";
    });

    await squashMerge(6, "proj", "feat/x", "feat: widget", false);

    const calls = gitCalls();

    expect(calls).toContainEqual(["merge", "--abort"]);
    expect(calls).toContainEqual(["checkout", "feat/x-t6"]);
    expect(calls).toContainEqual(["reset", "--soft", "feat/x"]);
    expect(calls).toContainEqual([
      "commit",
      "-m",
      "squashed: feat: widget",
    ]);
    expect(calls).toContainEqual(["rebase", "feat/x"]);

    const checkoutFeatureCalls = calls.filter(
      (c) => c[0] === "checkout" && c[1] === "feat/x",
    );
    expect(checkoutFeatureCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Pre-merge dirty index guard ──────────────────────────────────────────────

describe("squashMerge — dirty index guard", () => {
  it("resets dirty index before merge attempt", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "status" && a[1] === "--porcelain") {
        return "M  src/dirty.ts";
      }
      return "";
    });

    await squashMerge(1, "proj", "feat/x", "feat: test", false);

    const calls = gitCalls();

    // Should check status first
    expect(calls).toContainEqual(["status", "--porcelain"]);

    // Should abort and reset before proceeding
    const statusIdx = calls.findIndex(c => c[0] === "status" && c[1] === "--porcelain");
    const mergeAbortIdx = calls.findIndex((c, i) => i > statusIdx && c[0] === "merge" && c[1] === "--abort");
    const resetIdx = calls.findIndex((c, i) => i > statusIdx && c[0] === "reset" && c[1] === "--hard");
    const checkoutIdx = calls.findIndex(c => c[0] === "checkout" && c[1] === "feat/x");

    expect(mergeAbortIdx).toBeGreaterThan(statusIdx);
    expect(resetIdx).toBeGreaterThan(statusIdx);
    expect(checkoutIdx).toBeGreaterThan(resetIdx);
  });

  it("proceeds normally when merge --abort fails inside guard", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "status" && a[1] === "--porcelain") {
        return "M  src/dirty.ts";
      }
      // merge --abort throws (no merge in progress, just dirty files)
      if (cmd === "git" && a[0] === "merge" && a[1] === "--abort") {
        throw new Error("fatal: There is no merge to abort");
      }
      return "";
    });

    // Should still succeed — the catch {} in the guard silences the error
    await squashMerge(1, "proj", "feat/x", "feat: test", false);

    const calls = gitCalls();
    expect(calls).toContainEqual(["commit", "-m", "feat: test"]);
  });

  it("skips reset when index is clean", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "status" && a[1] === "--porcelain") {
        return "";
      }
      return "";
    });

    await squashMerge(1, "proj", "feat/x", "feat: test", false);

    const calls = gitCalls();

    // Should check status
    expect(calls).toContainEqual(["status", "--porcelain"]);

    // Should NOT have merge --abort or reset --hard before checkout
    const statusIdx = calls.findIndex(c => c[0] === "status" && c[1] === "--porcelain");
    const checkoutIdx = calls.findIndex(c => c[0] === "checkout" && c[1] === "feat/x");

    // No reset --hard between status check and checkout
    const resetsBetween = calls.filter(
      (c, i) => i > statusIdx && i < checkoutIdx && c[0] === "reset" && c[1] === "--hard",
    );
    expect(resetsBetween).toHaveLength(0);
  });
});

// ─── Outer catch strengthening ────────────────────────────────────────────────

describe("squashMerge — outer catch includes reset --hard", () => {
  it("runs merge --abort, checkout, and reset --hard on failure", async () => {
    mockRunBuildValidation.mockReturnValue({
      success: false,
      failedPhase: "build",
      error: "build failed",
      stderr: "tsc error",
      tscErrorCount: 1,
      testFailCount: 0,
      testPassCount: 0,
    });

    await expect(
      squashMerge(5, "proj", "feat/x", "feat: bad", false),
    ).rejects.toThrow();

    const calls = gitCalls();

    // Outer catch should run all three recovery steps
    // Find the last merge --abort (from outer catch, not from conflict resolution)
    const lastMergeAbort = calls.findLastIndex(c => c[0] === "merge" && c[1] === "--abort");
    const lastCheckout = calls.findLastIndex(c => c[0] === "checkout" && c[1] === "feat/x");
    const lastReset = calls.findLastIndex(c => c[0] === "reset" && c[1] === "--hard" && c[2] === "HEAD");

    expect(lastMergeAbort).toBeGreaterThan(-1);
    expect(lastCheckout).toBeGreaterThan(lastMergeAbort);
    expect(lastReset).toBeGreaterThan(lastCheckout);
  });
});
