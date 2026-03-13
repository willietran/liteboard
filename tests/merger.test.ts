import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
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
import type { Session, Task } from "../src/types.js";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRunBuildValidation = vi.mocked(runBuildValidation);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns all git calls as [command, args] tuples. */
function gitCalls(): string[][] {
  return mockExec.mock.calls
    .filter((c) => c[0] === "git")
    .map((c) => c[1] as string[]);
}

function makeTask(id: number, commitMessage: string = `feat: task ${id}`): Task {
  return {
    id,
    title: `Task ${id}`,
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    explore: [],
    tddPhase: "",
    commitMessage,
    complexity: 1,
    status: "done",
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
  };
}

function makeSession(id: string, tasks: Task[], branchName?: string): Session {
  return {
    id,
    tasks,
    complexity: 1,
    focus: `Session ${id} focus`,
    status: "done",
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 1,
    branchName: branchName ?? `feat/x-s${id}`,
  };
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

    const session = makeSession("1", [makeTask(1, "chore: test")]);
    await squashMerge(session, "feat/x", false);

    expect(mockRunBuildValidation).toHaveBeenCalledWith(
      "/repo/root",
      expect.objectContaining({ cleanInstall: false }),
    );
  });

  it("commits with the correct message after successful merge (single-task session)", async () => {
    const session = makeSession("3", [makeTask(3, "feat: add widget")]);
    await squashMerge(session, "feat/x", false);

    expect(gitCalls()).toContainEqual(["checkout", "feat/x"]);
    expect(gitCalls()).toContainEqual([
      "merge",
      "--squash",
      "--no-commit",
      "feat/x-s3",
    ]);
    expect(gitCalls()).toContainEqual(["commit", "-F", "/tmp/commit-msg-s3.txt"]);
    expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/commit-msg-s3.txt", "feat: add widget");
  });

  it("removes ephemeral files (including .qa-report.md) from staging before commit", async () => {
    const session = makeSession("5", [makeTask(5, "fix: stuff")]);
    await squashMerge(session, "feat/x", false);

    expect(gitCalls()).toContainEqual(
      expect.arrayContaining([
        "reset",
        "HEAD",
        "--",
        ".memory-entry.md",
        ".brief-s5.md",
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
    const session = makeSession("5", [makeTask(5, "fix: stuff")]);
    await squashMerge(session, "feat/x", false);

    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map(c => c[0]);
    expect(unlinkCalls).toContain(".memory-entry.md");
    expect(unlinkCalls).toContain(".brief-s5.md");
    expect(unlinkCalls).toContain(".qa-report.md");
  });

  it("stages lockfile after build validation", async () => {
    const session = makeSession("9", [makeTask(9, "chore: lock")]);
    await squashMerge(session, "feat/x", false);

    // Should stage package-lock.json
    expect(gitCalls()).toContainEqual(["add", "package-lock.json"]);
  });
});

// ─── squashMerge: commit message building ────────────────────────────────────

describe("squashMerge — commit message building", () => {
  it("single-task session uses task commitMessage directly", async () => {
    const session = makeSession("10", [makeTask(1, "fix: specific task message")]);
    await squashMerge(session, "feat/x", false);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/commit-msg-s10.txt",
      "fix: specific task message",
    );
  });

  it("multi-task session builds combined commit message", async () => {
    const session = makeSession("11", [
      makeTask(1, "feat: add login"),
      makeTask(2, "feat: add signup"),
    ]);
    session.focus = "Auth feature";
    await squashMerge(session, "feat/x", false);

    const expectedMsg = `session S11: Auth feature\n\n- task 1: feat: add login\n- task 2: feat: add signup`;
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/commit-msg-s11.txt",
      expectedMsg,
    );
  });

  it("branch name comes from session.branchName", async () => {
    const session = makeSession("12", [makeTask(1, "chore: test")], "my-feature-s12");
    await squashMerge(session, "feat/x", false);

    expect(gitCalls()).toContainEqual([
      "merge",
      "--squash",
      "--no-commit",
      "my-feature-s12",
    ]);
  });

  it("ephemeral file naming uses s${sessionId}", async () => {
    const session = makeSession("7", [makeTask(1, "chore: test")]);
    await squashMerge(session, "feat/x", false);

    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map(c => c[0] as string);
    expect(unlinkCalls).toContain(".brief-s7.md");
    expect(unlinkCalls).not.toContain(".brief-t1.md");

    expect(gitCalls()).toContainEqual(
      expect.arrayContaining(["reset", "HEAD", "--", ".memory-entry.md", ".brief-s7.md", ".qa-report.md"]),
    );
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

    const session = makeSession("2", [makeTask(2, "feat: bad")]);
    await expect(
      squashMerge(session, "feat/x", false),
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

    const session = makeSession("10", [makeTask(10, "feat: bad-types")]);
    await expect(
      squashMerge(session, "feat/x", false),
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

    const session = makeSession("11", [makeTask(11, "feat: bad-tests")]);
    await expect(
      squashMerge(session, "feat/x", false),
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

    const session = makeSession("8", [makeTask(8, "feat: bad-deps")]);
    await expect(
      squashMerge(session, "feat/x", false),
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

    const s1 = makeSession("1", [makeTask(1, "first")]);
    const s2 = makeSession("2", [makeTask(2, "second")]);
    const p1 = squashMerge(s1, "feat/x", false);
    const p2 = squashMerge(s2, "feat/x", false);

    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
  });
});

// ─── Conflict: package.json now goes through rebase-retry ────────────────────

describe("squashMerge — package.json conflict triggers rebase-retry", () => {
  it("package.json conflicts go through rebase-retry (no auto-resolve)", async () => {
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
      if (cmd === "git" && a[0] === "merge" && a[1] === "--abort") {
        throw new Error("fatal: There is no merge to abort (MERGE_HEAD missing)");
      }
      return "";
    });

    const session = makeSession("4", [makeTask(4, "fix: deps")]);
    await squashMerge(session, "feat/x", false);

    const calls = gitCalls();

    // Should NOT auto-resolve with checkout --theirs
    expect(calls).not.toContainEqual(["checkout", "--theirs", "package.json"]);
    expect(calls).not.toContainEqual(["checkout", "--theirs", "package-lock.json"]);

    // Should go through rebase-retry path
    expect(calls).toContainEqual(["reset", "--hard", "HEAD"]);
    expect(calls).toContainEqual(["checkout", "feat/x-s4"]);
    expect(calls).toContainEqual(["reset", "--soft", "feat/x"]);
    expect(calls).toContainEqual(["rebase", "feat/x"]);
  });

  it("does not call npm install for package.json conflicts", async () => {
    let mergeAttempt = 0;

    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "merge" && a[1] === "--squash") {
        mergeAttempt++;
        if (mergeAttempt === 1) throw new Error("merge conflict");
        return "";
      }
      if (cmd === "git" && a[0] === "merge" && a[1] === "--abort") {
        throw new Error("fatal: There is no merge to abort");
      }
      return "";
    });

    const session = makeSession("4", [makeTask(4, "fix: deps")]);
    await squashMerge(session, "feat/x", false);

    // No npm calls should have been made
    const npmCalls = mockExec.mock.calls.filter(c => c[0] === "npm");
    expect(npmCalls).toHaveLength(0);
  });
});

// ─── squashMerge: no package.json (non-npm project) ─────────────────────────

describe("squashMerge — no package.json", () => {
  it("skips lockfile staging when no package.json", async () => {
    mockExistsSync.mockReturnValue(false);

    const session = makeSession("7", [makeTask(7, "chore: no-npm")]);
    await squashMerge(session, "feat/x", false);

    // runBuildValidation should have been called (it handles the no-pkg case internally)
    expect(mockRunBuildValidation).toHaveBeenCalled();

    // Commit still happens
    expect(gitCalls()).toContainEqual(["commit", "-F", "/tmp/commit-msg-s7.txt"]);
  });
});

// ─── Conflict: other files → squash-rebase-retry ─────────────────────────────

describe("squashMerge — non-package conflict triggers squash-rebase-retry", () => {
  it("squashes session branch, rebases, and retries merge on non-package conflicts", async () => {
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
      // Simulate real squash merge: MERGE_HEAD doesn't exist, so merge --abort throws
      if (cmd === "git" && a[0] === "merge" && a[1] === "--abort") {
        throw new Error("fatal: There is no merge to abort (MERGE_HEAD missing)");
      }
      return "";
    });

    const session = makeSession("6", [makeTask(6, "feat: widget")]);
    await squashMerge(session, "feat/x", false);

    const calls = gitCalls();

    // Should use reset --hard (not merge --abort) to clean up after squash merge conflict
    const conflictResetIdx = calls.findIndex(
      (c, i) => {
        // Find the reset --hard that comes after the first failed merge --squash
        const mergeSquashIdx = calls.findIndex(cc => cc[0] === "merge" && cc[1] === "--squash");
        return i > mergeSquashIdx && c[0] === "reset" && c[1] === "--hard" && c[2] === "HEAD";
      },
    );
    expect(conflictResetIdx).toBeGreaterThan(-1);

    expect(calls).toContainEqual(["checkout", "feat/x-s6"]);
    expect(calls).toContainEqual(["reset", "--soft", "feat/x"]);
    expect(calls).toContainEqual(["commit", "-F", "/tmp/commit-msg-s6.txt"]);
    expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/commit-msg-s6.txt", "squashed: feat: widget");
    expect(calls).toContainEqual(["rebase", "feat/x"]);

    const checkoutFeatureCalls = calls.filter(
      (c) => c[0] === "checkout" && c[1] === "feat/x",
    );
    expect(checkoutFeatureCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("uses reset --hard instead of merge --abort for squash merge abort", async () => {
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
      if (cmd === "git" && a[0] === "diff" && a.includes("--diff-filter=U")) {
        return "tsconfig.json";
      }
      // merge --abort always throws for squash merges (no MERGE_HEAD)
      if (cmd === "git" && a[0] === "merge" && a[1] === "--abort") {
        throw new Error("fatal: There is no merge to abort (MERGE_HEAD missing)");
      }
      return "";
    });

    const session = makeSession("7", [makeTask(7, "fix: config")]);
    await squashMerge(session, "feat/x", false);

    const calls = gitCalls();

    // Must NOT contain merge --abort in the conflict resolution path
    // (the outer catch may still attempt it as a defensive measure, but
    // the conflict resolution block should use reset --hard)
    const firstMergeSquashIdx = calls.findIndex(c => c[0] === "merge" && c[1] === "--squash");
    const taskCheckoutIdx = calls.findIndex(c => c[0] === "checkout" && c[1] === "feat/x-s7");

    // Between failed squash merge and session branch checkout, should see reset --hard HEAD
    const resetBetween = calls.filter(
      (c, i) => i > firstMergeSquashIdx && i < taskCheckoutIdx &&
        c[0] === "reset" && c[1] === "--hard" && c[2] === "HEAD",
    );
    expect(resetBetween.length).toBe(1);

    // Full rebase-retry sequence should follow
    expect(calls).toContainEqual(["checkout", "feat/x-s7"]);
    expect(calls).toContainEqual(["reset", "--soft", "feat/x"]);
    expect(calls).toContainEqual(["commit", "-F", "/tmp/commit-msg-s7.txt"]);
    expect(calls).toContainEqual(["rebase", "feat/x"]);
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

    const session = makeSession("1", [makeTask(1, "feat: test")]);
    await squashMerge(session, "feat/x", false);

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
    const session = makeSession("1", [makeTask(1, "feat: test")]);
    await squashMerge(session, "feat/x", false);

    const calls = gitCalls();
    expect(calls).toContainEqual(["commit", "-F", "/tmp/commit-msg-s1.txt"]);
  });

  it("skips reset when index is clean", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "status" && a[1] === "--porcelain") {
        return "";
      }
      return "";
    });

    const session = makeSession("1", [makeTask(1, "feat: test")]);
    await squashMerge(session, "feat/x", false);

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

// ─── no git clean -fd in main repo ────────────────────────────────────────────

describe("squashMerge — no git clean -fd in main repo", () => {
  it("does not call git clean -fd (would nuke untracked project files)", async () => {
    const session = makeSession("1", [makeTask(1, "feat: test")]);
    await squashMerge(session, "feat/x", false);

    const calls = gitCalls();
    const cleanCalls = calls.filter(c => c[0] === "clean" && c[1] === "-fd");
    expect(cleanCalls).toHaveLength(0);
  });

  it("does not call git clean -fd on build failure", async () => {
    mockRunBuildValidation.mockReturnValue({
      success: false,
      failedPhase: "build",
      error: "build failed",
      stderr: "tsc error",
      tscErrorCount: 1,
      testFailCount: 0,
      testPassCount: 0,
    });

    const session = makeSession("2", [makeTask(2, "feat: bad")]);
    await expect(squashMerge(session, "feat/x", false)).rejects.toThrow();

    const calls = gitCalls();
    const cleanCalls = calls.filter(c => c[0] === "clean" && c[1] === "-fd");
    expect(cleanCalls).toHaveLength(0);
  });

  it("does not call git clean -fd in abortAndRecover", () => {
    abortAndRecover("feat/x", false);

    const calls = gitCalls();
    const cleanCalls = calls.filter(c => c[0] === "clean" && c[1] === "-fd");
    expect(cleanCalls).toHaveLength(0);
  });
});

// ─── commit via tempfile ──────────────────────────────────────────────────────

describe("squashMerge — commit via tempfile", () => {
  it("commits via -F tempfile instead of -m", async () => {
    const session = makeSession("3", [makeTask(3, "feat: add widget")]);
    await squashMerge(session, "feat/x", false);

    expect(gitCalls()).toContainEqual(["commit", "-F", "/tmp/commit-msg-s3.txt"]);
    expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/commit-msg-s3.txt", "feat: add widget");
  });

  it("cleans up tempfile after commit", async () => {
    const session = makeSession("3", [makeTask(3, "feat: test")]);
    await squashMerge(session, "feat/x", false);

    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/tmp/commit-msg-s3.txt");
  });

  it("cleans up tempfile even when commit throws", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "commit") {
        throw new Error("commit failed");
      }
      return "";
    });

    const session = makeSession("3", [makeTask(3, "feat: bad")]);
    await expect(squashMerge(session, "feat/x", false)).rejects.toThrow();

    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith("/tmp/commit-msg-s3.txt");
  });

  it("squash commit during rebase-retry also uses -F tempfile", async () => {
    let mergeAttempt = 0;

    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "merge" && a[1] === "--squash") {
        mergeAttempt++;
        if (mergeAttempt === 1) throw new Error("merge conflict");
        return "";
      }
      if (cmd === "git" && a[0] === "diff" && a.includes("--diff-filter=U")) {
        return "src/index.ts";
      }
      if (cmd === "git" && a[0] === "merge" && a[1] === "--abort") {
        throw new Error("fatal: There is no merge to abort (MERGE_HEAD missing)");
      }
      return "";
    });

    const session = makeSession("6", [makeTask(6, "feat: widget")]);
    await squashMerge(session, "feat/x", false);

    expect(gitCalls()).toContainEqual(["commit", "-F", "/tmp/commit-msg-s6.txt"]);
    expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/commit-msg-s6.txt", "squashed: feat: widget");
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

    const session = makeSession("5", [makeTask(5, "feat: bad")]);
    await expect(
      squashMerge(session, "feat/x", false),
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
