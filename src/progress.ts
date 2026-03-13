import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Task, ProgressEntry } from "./types.js";

const PROGRESS_FILE = "progress.md";

// ─── writeProgress ───────────────────────────────────────────────────────────

export function writeProgress(tasks: Task[], projectDir: string): void {
  const escPipe = (s: string) => s.replace(/\|/g, "\\|");
  const lines: string[] = [];

  // Header
  lines.push("| Task | Title | Status | Completed At | Failure Summary |");
  lines.push("| --- | --- | --- | --- | --- |");

  // Rows
  for (const t of tasks) {
    const completedAt = t.completedAt ?? "";
    const failureSummary = t.status === "failed" || t.status === "needs_human" ? t.lastLine : "";
    lines.push(
      `| ${t.id} | ${escPipe(t.title)} | ${t.status} | ${completedAt} | ${escPipe(failureSummary)} |`,
    );
  }

  const content = lines.join("\n") + "\n";

  // Atomic write: write to temp file, then rename
  const finalPath = join(projectDir, PROGRESS_FILE);
  const tempPath = finalPath + ".tmp";
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, finalPath);
}

// ─── readProgress ────────────────────────────────────────────────────────────

export function readProgress(projectDir: string): Map<number, ProgressEntry> {
  const filePath = join(projectDir, PROGRESS_FILE);
  const result = new Map<number, ProgressEntry>();

  if (!existsSync(filePath)) {
    return result;
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Skip header (line 0) and separator (line 1)
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith("|")) continue;

    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")).filter(Boolean);
    // cells: [Task, Title, Status, Completed At, Failure Summary]
    if (cells.length < 4) continue;

    const taskId = parseInt(cells[0], 10);
    const status = cells[2];
    const completedAt = cells[3];

    if (status === "done" && completedAt) {
      result.set(taskId, { status: "done", completedAt });
    } else if (status === "needs_human") {
      result.set(taskId, { status: "needs_human" });
    }
  }

  return result;
}

// ─── detectCompletedFromGitLog ───────────────────────────────────────────────

export function detectCompletedFromGitLog(
  branch: string,
  tasks: Task[],
  verbose: boolean,
): Set<number> {
  const completed = new Set<number>();

  let logOutput: string;
  try {
    const buf = execFileSync("git", ["log", branch, "--format=%s"], {
      encoding: "utf-8",
    });
    logOutput = typeof buf === "string" ? buf : String(buf);
  } catch {
    if (verbose) {
      console.error(`Could not read git log for branch: ${branch}`);
    }
    return completed;
  }

  const commitMessages = logOutput.split("\n").filter(Boolean);

  // Build lookup: commitMessage -> task id
  const messageToId = new Map<string, number>();
  for (const t of tasks) {
    messageToId.set(t.commitMessage, t.id);
  }

  for (const msg of commitMessages) {
    // Match [task N] prefix
    const prefixMatch = msg.match(/^\[task\s+(\d+)\]/);
    if (prefixMatch) {
      const id = parseInt(prefixMatch[1], 10);
      completed.add(id);
      continue;
    }

    // Match exact commitMessage
    const id = messageToId.get(msg);
    if (id !== undefined) {
      completed.add(id);
    }
  }

  return completed;
}
