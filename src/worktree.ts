import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import type { Task } from "./types.js";

// ─── git helper ─────────────────────────────────────────────────────────────

export function git(
  args: string[],
  opts?: { cwd?: string; verbose?: boolean },
): string {
  if (opts?.verbose) {
    console.log(`[worktree] git ${args.join(" ")}`);
  }
  const result = execFileSync("git", args, {
    encoding: "utf-8",
    cwd: opts?.cwd,
  });
  return typeof result === "string" ? result.trim() : String(result).trim();
}

// ─── getWorktreePath ────────────────────────────────────────────────────────

export function getWorktreePath(slug: string, taskId: number): string {
  return `/tmp/liteboard-${slug}-t${taskId}`;
}

// ─── setupFeatureBranch ─────────────────────────────────────────────────────

export function setupFeatureBranch(
  branch: string,
  verbose: boolean,
): void {
  let branchExists = false;
  try {
    git(["rev-parse", "--verify", branch], { verbose });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    git(["checkout", branch], { verbose });
  } else {
    git(["checkout", "-b", branch], { verbose });
  }
}

// ─── createWorktree ─────────────────────────────────────────────────────────

export function createWorktree(
  slug: string,
  taskId: number,
  featureBranch: string,
  verbose: boolean,
): string {
  const wtPath = getWorktreePath(slug, taskId);
  const taskBranch = `${featureBranch}-t${taskId}`;

  // Clean up stale worktree if path exists
  if (existsSync(wtPath)) {
    try {
      git(["worktree", "remove", wtPath, "--force"], { verbose });
    } catch {
      // Ignore — we'll rm the directory next
    }
    rmSync(wtPath, { recursive: true, force: true });
  }

  // Delete stale task branch if it exists
  try {
    git(["branch", "-D", taskBranch], { verbose });
  } catch {
    // Branch didn't exist — that's fine
  }

  // Create the worktree with a new task branch from the feature branch
  git(["worktree", "add", wtPath, "-b", taskBranch, featureBranch], { verbose });

  return wtPath;
}

// ─── cleanupWorktree ────────────────────────────────────────────────────────

export function cleanupWorktree(
  slug: string,
  taskId: number,
  featureBranch: string,
  verbose: boolean,
): void {
  const wtPath = getWorktreePath(slug, taskId);
  const taskBranch = `${featureBranch}-t${taskId}`;

  try {
    git(["worktree", "remove", wtPath, "--force"], { verbose });
  } catch {
    // Always continue
  }

  try {
    git(["branch", "-D", taskBranch], { verbose });
  } catch {
    // Always continue
  }
}

// ─── cleanupAllWorktrees ────────────────────────────────────────────────────

export function cleanupAllWorktrees(
  tasks: Task[],
  slug: string,
  featureBranch: string,
  verbose: boolean,
): void {
  for (const task of tasks) {
    cleanupWorktree(slug, task.id, featureBranch, verbose);
  }
}

// ─── cleanupStaleWorktrees ──────────────────────────────────────────────────

export function cleanupStaleWorktrees(
  slug: string,
  verbose: boolean,
): void {
  const pattern = `/tmp/liteboard-${slug}-`;
  let output: string;

  try {
    output = git(["worktree", "list"], { verbose });
  } catch {
    return;
  }

  const lines = output.split("\n").filter(Boolean);
  for (const line of lines) {
    const wtPath = line.split(/\s+/)[0];
    if (wtPath.startsWith(pattern)) {
      try {
        git(["worktree", "remove", wtPath, "--force"], { verbose });
      } catch {
        // Ignore removal failures for stale worktrees
      }
    }
  }
}
