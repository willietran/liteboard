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

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  git,
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
    tddPhase: "green",
    commitMessage: "",
    complexity: 1,
    status: "blocked",
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

  it("logs when verbose is true", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    git(["branch", "-a"], { verbose: true });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("git branch -a"),
    );
    spy.mockRestore();
  });

  it("does not log when verbose is false", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    git(["branch", "-a"], { verbose: false });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── setupFeatureBranch ─────────────────────────────────────────────────────

describe("setupFeatureBranch", () => {
  it("creates new branch if it doesn't exist", () => {
    // First call: rev-parse throws (branch doesn't exist)
    mockExec.mockImplementationOnce(() => {
      throw new Error("not a valid ref");
    });
    // Second call: checkout -b succeeds
    mockExec.mockReturnValueOnce(Buffer.from(""));

    setupFeatureBranch("feat/cool", false);

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
    // rev-parse succeeds (branch exists)
    mockExec.mockReturnValueOnce(Buffer.from("abc123"));
    // checkout succeeds
    mockExec.mockReturnValueOnce(Buffer.from(""));

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
