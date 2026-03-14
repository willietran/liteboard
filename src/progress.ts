import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Task, Session, ProgressEntry, SessionProgressEntry } from "./types.js";

const PROGRESS_FILE = "progress.md";

// ─── writeProgress ───────────────────────────────────────────────────────────

export function writeProgress(sessions: Session[], tasks: Task[], projectDir: string): void {
  const escPipe = (s: string) => s.replace(/\|/g, "\\|");
  const lines: string[] = [];

  // Session table first
  lines.push("## Sessions");
  lines.push("| Session | Focus | Status | Completed At |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of sessions) {
    const completedAt = s.completedAt ?? "";
    lines.push(`| ${s.id} | ${escPipe(s.focus)} | ${s.status} | ${completedAt} |`);
  }

  lines.push("");

  // Task table second
  lines.push("## Tasks");
  lines.push("| Task | Title | Status | Completed At | Failure Summary |");
  lines.push("| --- | --- | --- | --- | --- |");
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

export function readProgress(projectDir: string): {
  tasks: Map<number, ProgressEntry>;
  sessions: Map<string, SessionProgressEntry>;
} {
  const filePath = join(projectDir, PROGRESS_FILE);
  const taskResult = new Map<number, ProgressEntry>();
  const sessionResult = new Map<string, SessionProgressEntry>();

  if (!existsSync(filePath)) {
    return { tasks: taskResult, sessions: sessionResult };
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Detect format: new format has "## Sessions" header, old format does not
  const hasSessionsHeader = lines.some((l) => l.trim() === "## Sessions");

  if (!hasSessionsHeader) {
    // Backward compat: old format — parse entire content as tasks table
    parseTasksTable(lines, taskResult);
    return { tasks: taskResult, sessions: sessionResult };
  }

  // New format: find sections by header
  let inSessions = false;
  let inTasks = false;
  const sessionLines: string[] = [];
  const taskLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "## Sessions") {
      inSessions = true;
      inTasks = false;
      continue;
    }
    if (line.trim() === "## Tasks") {
      inTasks = true;
      inSessions = false;
      continue;
    }
    if (line.startsWith("## ")) {
      inSessions = false;
      inTasks = false;
      continue;
    }
    if (inSessions) sessionLines.push(line);
    if (inTasks) taskLines.push(line);
  }

  parseSessionsTable(sessionLines, sessionResult);
  parseTasksTable(taskLines, taskResult);

  return { tasks: taskResult, sessions: sessionResult };
}

function parseSessionsTable(lines: string[], result: Map<string, SessionProgressEntry>): void {
  // Skip header (line 0) and separator (line 1)
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith("|")) continue;

    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")).filter(Boolean);
    // cells: [Session, Focus, Status, Completed At]
    if (cells.length < 3) continue;

    const sessionId = cells[0]; // e.g. "S1"
    const status = cells[2];
    const completedAt = cells[3] ?? "";

    if (status === "done" && completedAt) {
      result.set(sessionId, { status: "done", completedAt });
    } else if (status === "needs_human") {
      result.set(sessionId, { status: "needs_human" });
    }
    // "merging" → not added to result (re-queued on resume)
  }
}

function parseTasksTable(lines: string[], result: Map<number, ProgressEntry>): void {
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
