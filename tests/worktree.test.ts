import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../src/types.js";

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
} from "../src/worktree.js";

const mockExec = vi.mocked(execFileSync);
const mockExists = vi.mocked(existsSync);
const mockRm = vi.mocked(rmSync);

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeTask(partial: Partial<Task> & { id: number }): Task {
  return {
    title: `Task ${partial.id}`,
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    tddPhase: "GREEN",
    commitMessage: "",
    complexity: 1,
    status: "blocked",
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
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
  it("creates worktree at /tmp/liteboard-<slug>-t<taskId>", () => {
    mockExists.mockReturnValue(false);
    // branch delete attempt (stale cleanup)
    mockExec.mockImplementation(() => Buffer.from(""));

    const path = createWorktree("my-proj", 7, "feat/cool", false);

    expect(path).toBe("/tmp/liteboard-my-proj-t7");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/tmp/liteboard-my-proj-t7", "-b", "feat/cool-t7", "feat/cool"],
      expect.anything(),
    );
  });

  it("cleans up stale worktree if path exists", () => {
    mockExists.mockReturnValue(true);
    mockExec.mockImplementation(() => Buffer.from(""));

    createWorktree("my-proj", 3, "feat/cool", false);

    // Should remove existing worktree first
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-t3", "--force"],
      expect.anything(),
    );
    // Then should remove the directory
    expect(mockRm).toHaveBeenCalledWith("/tmp/liteboard-my-proj-t3", {
      recursive: true,
      force: true,
    });
  });

  it("deletes stale task branch before creating", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => Buffer.from(""));

    createWorktree("my-proj", 5, "feat/cool", false);

    // Should try to delete the task branch first
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-t5"],
      expect.anything(),
    );
  });
});

// ─── cleanupWorktree ────────────────────────────────────────────────────────

describe("cleanupWorktree", () => {
  it("removes worktree and deletes task branch", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", 2, "feat/cool", false);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-t2", "--force"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-t2"],
      expect.anything(),
    );
  });

  it("doesn't throw on failure (always runs)", () => {
    mockExec.mockImplementation(() => {
      throw new Error("worktree remove failed");
    });

    expect(() =>
      cleanupWorktree("my-proj", 2, "feat/cool", false),
    ).not.toThrow();
  });

  it("preserves task branch when preserveBranch is true", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", 2, "feat/cool", false, { preserveBranch: true });

    // Worktree should still be removed
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-my-proj-t2", "--force"],
      expect.anything(),
    );
    // Branch should NOT be deleted
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-t2"],
      expect.anything(),
    );
  });

  it("deletes task branch when preserveBranch is false", () => {
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupWorktree("my-proj", 2, "feat/cool", false, { preserveBranch: false });

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/cool-t2"],
      expect.anything(),
    );
  });
});

// ─── cleanupAllWorktrees ────────────────────────────────────────────────────

describe("cleanupAllWorktrees", () => {
  it("cleans up all task worktrees", () => {
    const tasks: Task[] = [
      makeTask({ id: 1 }),
      makeTask({ id: 2 }),
      makeTask({ id: 3 }),
    ];
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupAllWorktrees(tasks, "proj", "feat/x", false);

    // Should attempt worktree remove for each task
    for (const t of tasks) {
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", `/tmp/liteboard-proj-t${t.id}`, "--force"],
        expect.anything(),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", `feat/x-t${t.id}`],
        expect.anything(),
      );
    }
  });

  it("preserves branches of merge-failed tasks when preserveFailedBranches is true", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, status: "done", lastLine: "" }),
      makeTask({ id: 2, status: "failed", lastLine: "[MERGE FAILED] conflict in src/index.ts" }),
      makeTask({ id: 3, status: "failed", lastLine: "[EXIT 1]" }),
    ];
    mockExec.mockReturnValue(Buffer.from(""));

    cleanupAllWorktrees(tasks, "proj", "feat/x", false, { preserveFailedBranches: true });

    // Task 1 (done): branch should be deleted
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/x-t1"],
      expect.anything(),
    );
    // Task 2 (merge-failed): branch should be preserved
    expect(mockExec).not.toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/x-t2"],
      expect.anything(),
    );
    // Task 3 (failed but NOT merge failure): branch should be deleted
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "feat/x-t3"],
      expect.anything(),
    );
  });
});

// ─── cleanupStaleWorktrees ──────────────────────────────────────────────────

describe("cleanupStaleWorktrees", () => {
  it("removes orphan worktrees matching pattern", () => {
    const worktreeList = [
      "/Users/me/project  abc1234 [main]",
      "/tmp/liteboard-proj-t1  def5678 [feat/x-t1]",
      "/tmp/liteboard-proj-t5  ghi9012 [feat/x-t5]",
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
      ["worktree", "remove", "/tmp/liteboard-proj-t1", "--force"],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/tmp/liteboard-proj-t5", "--force"],
      expect.anything(),
    );
  });
});

// ─── getWorktreePath ────────────────────────────────────────────────────────

describe("getWorktreePath", () => {
  it("returns correct path", () => {
    expect(getWorktreePath("my-proj", 42)).toBe("/tmp/liteboard-my-proj-t42");
  });
});
