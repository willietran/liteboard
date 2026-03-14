import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "../src/types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("")),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  rmSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

// Mock the git module — worktree.ts imports git from ./git.js
// We re-export the mock so worktree functions use the same mock execFileSync
vi.mock("../src/git.js", async () => {
  const { execFileSync } = await import("node:child_process");
  return {
    git: (args: string[], opts?: { cwd?: string; verbose?: boolean }) => {
      const result = execFileSync("git", args, {
        encoding: "utf-8",
        cwd: opts?.cwd,
      });
      return typeof result === "string" ? result.trim() : String(result).trim();
    },
  };
});

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  setupFeatureBranch,
  createWorktree,
  cleanupWorktree,
  cleanupAllWorktrees,
  cleanupStaleWorktrees,
  getWorktreePath,
  recreateWorktreeFromBranch,
} from "../src/worktree.js";

const mockExec = vi.mocked(execFileSync);
const mockExists = vi.mocked(existsSync);
const mockRm = vi.mocked(rmSync);

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    tasks: [],
    complexity: 1,
    focus: `Session ${partial.id}`,
    status: "queued",
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
    ...partial,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue(Buffer.from(""));
});

// ─── setupFeatureBranch ─────────────────────────────────────────────────────

describe("setupFeatureBranch", () => {
  it("creates new branch if it doesn't exist", () => {
    mockExec
      // rev-parse HEAD succeeds (has commits)
      .mockReturnValueOnce(Buffer.from("abc123"))
      // rev-parse --verify branch throws (branch doesn't exist)
      .mockImplementationOnce(() => { throw new Error("not a valid ref"); })
      // checkout -b succeeds
      .mockReturnValueOnce(Buffer.from(""));

    setupFeatureBranch("feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "feat/cool"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "feat/cool"],
      expect.anything(),
    );
  });

  it("checks out existing branch", () => {
    mockExec
      // rev-parse HEAD succeeds
      .mockReturnValueOnce(Buffer.from("abc123"))
      // rev-parse --verify branch succeeds
      .mockReturnValueOnce(Buffer.from("def456"))
      // checkout succeeds
      .mockReturnValueOnce(Buffer.from(""));

    setupFeatureBranch("feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "feat/cool"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["checkout", "feat/cool"],
      expect.anything(),
    );
  });

  it("creates initial commit on unborn HEAD", () => {
    mockExec
      // rev-parse HEAD throws (unborn HEAD)
      .mockImplementationOnce(() => { throw new Error("unknown revision HEAD"); })
      // commit --allow-empty succeeds
      .mockReturnValueOnce(Buffer.from(""))
      // rev-parse --verify branch throws (branch doesn't exist)
      .mockImplementationOnce(() => { throw new Error("not a valid ref"); })
      // checkout -b succeeds
      .mockReturnValueOnce(Buffer.from(""));

    setupFeatureBranch("feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["commit", "--allow-empty", "-m", "chore: initial commit"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "feat/cool"],
      expect.anything(),
    );
  });

  it("throws clear error when initial commit fails (e.g. missing git config)", () => {
    mockExec
      // rev-parse HEAD throws (unborn HEAD)
      .mockImplementationOnce(() => { throw new Error("unknown revision HEAD"); })
      // commit --allow-empty also throws (no git user configured)
      .mockImplementationOnce(() => { throw new Error("Please tell me who you are"); });

    expect(() => setupFeatureBranch("feat/cool", false)).toThrow(
      /Cannot create initial commit.*git user\.name\/email configured/,
    );
  });
});

// ─── createWorktree ─────────────────────────────────────────────────────────

describe("createWorktree", () => {
  it("creates worktree at /tmp/liteboard-<slug>-s<sessionId>", () => {
    mockExists.mockReturnValue(false);
    // branch delete attempt (stale cleanup)
    mockExec.mockImplementation(() => Buffer.from(""));

    const path = createWorktree("my-proj", "7", "feat/cool", false);

    expect(path).toBe("/tmp/liteboard-my-proj-s7");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/tmp/liteboard-my-proj-s7", "-b", "feat/cool-s7", "feat/cool"],
      expect.anything(),
    );
  });

  it("cleans up stale worktree if path exists", () => {
    mockExists.mockReturnValue(true);
    mockExec.mockImplementation(() => Buffer.from(""));

    createWorktree("my-proj", "3", "feat/cool", false);

    // Should remove existing worktree first
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-s3", "--force"],
      expect.anything(),
    );
    // Then should remove the directory
    expect(mockRm).toHaveBeenCalledWith("/tmp/liteboard-my-proj-s3", {
      recursive: true,
      force: true,
    });
  });

  it("deletes stale session branch before creating", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => Buffer.from(""));

    createWorktree("my-proj", "5", "feat/cool", false);

    // Should try to delete the session branch first
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-s5"],
      expect.anything(),
    );
  });

  it("runs worktree prune before deleting stale session branch", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => Buffer.from(""));

    createWorktree("my-proj", "5", "feat/cool", false);

    const calls = mockExec.mock.calls
      .filter(c => c[0] === "git")
      .map(c => c[1] as string[]);

    const pruneIdx = calls.findIndex(c => c[0] === "worktree" && c[1] === "prune");
    const branchDeleteIdx = calls.findIndex(c => c[0] === "branch" && c[1] === "-D");

    expect(pruneIdx).toBeGreaterThan(-1);
    expect(branchDeleteIdx).toBeGreaterThan(-1);
    expect(pruneIdx).toBeLessThan(branchDeleteIdx);
  });
});

// ─── cleanupWorktree ────────────────────────────────────────────────────────

describe("cleanupWorktree", () => {
  it("removes worktree and deletes session branch", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", "2", "feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-s2", "--force"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-s2"],
      expect.anything(),
    );
  });

  it("doesn't throw on failure (always runs)", () => {
    mockExec.mockImplementation(() => {
      throw new Error("worktree remove failed");
    });

    expect(() =>
      cleanupWorktree("my-proj", "2", "feat/cool", false),
    ).not.toThrow();
  });

  it("preserves session branch when preserveBranch is true", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", "2", "feat/cool", false, { preserveBranch: true });

    // Worktree should still be removed
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-s2", "--force"],
      expect.anything(),
    );
    // Branch should NOT be deleted
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-s2"],
      expect.anything(),
    );
  });

  it("deletes session branch when preserveBranch is false", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", "2", "feat/cool", false, { preserveBranch: false });

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-s2"],
      expect.anything(),
    );
  });

  it("runs worktree prune before deleting session branch", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", "2", "feat/cool", false);

    const calls = mockExec.mock.calls
      .filter(c => c[0] === "git")
      .map(c => c[1] as string[]);

    const pruneIdx = calls.findIndex(c => c[0] === "worktree" && c[1] === "prune");
    const branchDeleteIdx = calls.findIndex(c => c[0] === "branch" && c[1] === "-D");

    expect(pruneIdx).toBeGreaterThan(-1);
    expect(branchDeleteIdx).toBeGreaterThan(-1);
    expect(pruneIdx).toBeLessThan(branchDeleteIdx);
  });

  it("skips worktree prune when preserveBranch is true", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", "2", "feat/cool", false, { preserveBranch: true });

    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      ["worktree", "prune"],
      expect.anything(),
    );
  });
});

// ─── recreateWorktreeFromBranch ──────────────────────────────────────────────

describe("recreateWorktreeFromBranch", () => {
  it("creates worktree from existing branch without -b flag", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => Buffer.from(""));

    recreateWorktreeFromBranch("my-proj", "7", "feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/tmp/liteboard-my-proj-s7", "feat/cool-s7"],
      expect.anything(),
    );
    // Must NOT have been called with -b flag
    const addCalls = mockExec.mock.calls
      .filter(c => c[0] === "git" && (c[1] as string[])[0] === "worktree" && (c[1] as string[])[1] === "add");
    for (const call of addCalls) {
      expect(call[1] as string[]).not.toContain("-b");
    }
  });

  it("returns correct worktree path", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => Buffer.from(""));

    const p = recreateWorktreeFromBranch("my-proj", "7", "feat/cool", false);

    expect(p).toBe("/tmp/liteboard-my-proj-s7");
  });

  it("cleans up stale worktree if path exists", () => {
    mockExists.mockReturnValue(true);
    mockExec.mockImplementation(() => Buffer.from(""));

    recreateWorktreeFromBranch("my-proj", "3", "feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-s3", "--force"],
      expect.anything(),
    );
    expect(mockRm).toHaveBeenCalledWith("/tmp/liteboard-my-proj-s3", { recursive: true, force: true });
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/tmp/liteboard-my-proj-s3", "feat/cool-s3"],
      expect.anything(),
    );
  });

  it("does not delete the existing branch (preserves commits)", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => Buffer.from(""));

    recreateWorktreeFromBranch("my-proj", "5", "feat/cool", false);

    const branchDeleteCalls = mockExec.mock.calls.filter(
      c => c[0] === "git" && (c[1] as string[])[0] === "branch" && (c[1] as string[])[1] === "-D",
    );
    expect(branchDeleteCalls).toHaveLength(0);
  });
});

// ─── cleanupAllWorktrees ────────────────────────────────────────────────────

describe("cleanupAllWorktrees", () => {
  it("cleans up all session worktrees", () => {
    const sessions: Session[] = [
      makeSession({ id: "1" }),
      makeSession({ id: "2" }),
      makeSession({ id: "3" }),
    ];
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupAllWorktrees(sessions, "proj", "feat/x", false);

    // Should attempt worktree remove for each session
    for (const s of sessions) {
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", `/tmp/liteboard-proj-s${s.id}`, "--force"],
        expect.anything(),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", `feat/x-s${s.id}`],
        expect.anything(),
      );
    }
  });

  it("preserves branches of merge-failed sessions when preserveFailedBranches is true", () => {
    const sessions: Session[] = [
      makeSession({ id: "1", status: "done", lastLine: "" }),
      makeSession({ id: "2", status: "failed", lastLine: "[MERGE FAILED] conflict in src/index.ts" }),
      makeSession({ id: "3", status: "failed", lastLine: "[EXIT 1]" }),
    ];
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupAllWorktrees(sessions, "proj", "feat/x", false, { preserveFailedBranches: true });

    // Session 1 (done): branch should be deleted
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/x-s1"],
      expect.anything(),
    );
    // Session 2 (merge-failed): branch should be preserved
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/x-s2"],
      expect.anything(),
    );
    // Session 3 (failed but NOT merge failure): branch should be deleted
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/x-s3"],
      expect.anything(),
    );
  });
});

// ─── cleanupStaleWorktrees ──────────────────────────────────────────────────

describe("cleanupStaleWorktrees", () => {
  it("removes orphan worktrees matching pattern", () => {
    const worktreeList = [
      "/Users/me/project  abc1234 [main]",
      "/tmp/liteboard-proj-s1  def5678 [feat/x-s1]",
      "/tmp/liteboard-proj-s5  ghi9012 [feat/x-s5]",
    ].join("\n");

    mockExec.mockReturnValueOnce(Buffer.from(worktreeList));
    // Subsequent calls for removal succeed
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupStaleWorktrees("proj", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "list"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-proj-s1", "--force"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-proj-s5", "--force"],
      expect.anything(),
    );
  });
});

// ─── getWorktreePath ────────────────────────────────────────────────────────

describe("getWorktreePath", () => {
  it("returns correct path", () => {
    expect(getWorktreePath("my-proj", "42")).toBe("/tmp/liteboard-my-proj-s42");
  });
});
