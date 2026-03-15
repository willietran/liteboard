import { readFileSync } from "node:fs";
import type { Task, TddPhase, Session, SessionStatus } from "./types.js";

const VALID_TDD_PHASES: ReadonlySet<string> = new Set([
  "RED", "GREEN", "RED \u2192 GREEN", "RED \u2192 GREEN \u2192 REFACTOR", "Exempt",
]);

// ─── Field Parsers ───────────────────────────────────────────────────────────

function parseFileList(section: string, field: string): string[] {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
  const match = section.match(regex);
  if (!match) return [];
  const raw = match[1].trim();
  if (raw === "(none)" || raw.toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/`/g, ""))
    .filter(Boolean);
}

function parseDependsOn(section: string): number[] {
  const regex = /\*\*Depends on:\*\*\s*(.+)/i;
  const match = section.match(regex);
  if (!match) return [];
  const raw = match[1].trim();
  if (raw === "(none)" || raw.toLowerCase() === "none") return [];
  const taskRefs = raw.matchAll(/Task\s+(\d+)/gi);
  return [...taskRefs].map((m) => Number(m[1]));
}

/** Parses a bullet list after a bold **Header:** marker. Stops at the next bold field or ### header. */
function parseBulletList(section: string, header: string): string[] {
  const headerMatch = section.match(new RegExp(`\\*\\*${header}:\\*\\*`, "i"));
  if (!headerMatch) return [];

  const afterHeader = section.slice(headerMatch.index! + headerMatch[0].length);
  const items: string[] = [];
  const lines = afterHeader.split("\n");

  for (const line of lines) {
    // Stop at the next bold field or section header
    if (/^\*\*\w/.test(line.trim()) || /^###\s/.test(line.trim())) break;
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (bulletMatch) items.push(bulletMatch[1].trim());
  }

  return items;
}

function parseRequirements(section: string): string[] {
  return parseBulletList(section, "Requirements");
}

function parseExplore(section: string): string[] {
  return parseBulletList(section, "Explore");
}

function parseSingleValue(section: string, field: string): string {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
  const match = section.match(regex);
  if (!match) return "";
  return match[1].trim().replace(/^`|`$/g, "");
}

// ─── Main Parser ─────────────────────────────────────────────────────────────

export function parseManifest(manifestPath: string): Task[] {
  const content = readFileSync(manifestPath, "utf-8");

  // Split by ### Task N: <title> headers
  const taskHeaderRegex = /^###\s+Task\s+(\d+):\s*(.+)$/gm;
  const headers: { id: number; title: string; index: number }[] = [];

  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = taskHeaderRegex.exec(content)) !== null) {
    headers.push({
      id: Number(headerMatch[1]),
      title: headerMatch[2].trim(),
      index: headerMatch.index,
    });
  }

  const tasks: Task[] = [];

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : content.length;
    const section = content.slice(start, end);

    const dependsOn = parseDependsOn(section);

    const complexityStr = parseSingleValue(section, "Complexity Score");
    const complexity = complexityStr ? Number(complexityStr) : 0;

    const typeStr = parseSingleValue(section, "Type").toLowerCase();
    if (typeStr && typeStr !== "qa" && typeStr !== "implementation") {
      console.error(
        `\x1b[33mWarning: Task ${headers[i].id} has unrecognized Type "${typeStr}"\x1b[0m`,
      );
    }
    const type = typeStr === "qa" ? "qa" as const : undefined;

    const suggestedSession = parseSingleValue(section, "Suggested Session") || undefined;

    const task: Task = {
      id: headers[i].id,
      title: headers[i].title,
      ...(type ? { type } : {}),
      creates: parseFileList(section, "Creates"),
      modifies: parseFileList(section, "Modifies"),
      dependsOn,
      requirements: parseRequirements(section),
      explore: parseExplore(section),
      tddPhase: normalizeTddPhase(parseSingleValue(section, "TDD Phase")),
      commitMessage: parseSingleValue(section, "Commit"),
      complexity: isNaN(complexity) ? 0 : complexity,
      status: dependsOn.length === 0 ? "queued" : "blocked",
      stage: "",
      turnCount: 0,
      lastLine: "",
      bytesReceived: 0,
      ...(suggestedSession ? { suggestedSession } : {}),
    };

    tasks.push(task);
  }

  validateManifest(tasks);
  return tasks;
}

// ─── TDD Phase Normalization ────────────────────────────────────────────────

function normalizeTddPhase(raw: string): TddPhase {
  if (!raw) return "";
  // Normalize ASCII arrows (-> ) to unicode arrows (\u2192) before matching
  const normalized = raw.replace(/->/g, "\u2192").replace(/\s+/g, " ").trim();
  if (VALID_TDD_PHASES.has(normalized)) return normalized as TddPhase;
  // Try uppercase normalization
  const upper = normalized.toUpperCase();
  for (const valid of VALID_TDD_PHASES) {
    if (upper === valid.toUpperCase()) return valid as TddPhase;
  }
  return "";
}

// ─── Session Hints Table Parser ───────────────────────────────────────────────

/**
 * Searches for a markdown table under a header containing "Session"
 * (e.g. "## Session-Grouping Hints") and extracts session ID -> focus string.
 * Returns empty map if no table is found.
 */
function parseSessionHintsTable(content: string): Map<string, string> {
  // Find a heading that contains "Session"
  const headingMatch = content.match(/^#{1,3}\s+.*[Ss]ession.*$/m);
  if (!headingMatch) return new Map();

  const afterHeading = content.slice(headingMatch.index! + headingMatch[0].length);

  // Find the first markdown table after the heading
  const tableMatch = afterHeading.match(/(\|[^\n]+\|\n)+/);
  if (!tableMatch) return new Map();

  const tableText = tableMatch[0];
  const rows = tableText.split("\n").filter((r) => r.trim().startsWith("|") && r.trim().endsWith("|"));
  if (rows.length < 2) return new Map();

  // Parse header row to find column indices
  const headerCells = rows[0].split("|").map((c) => c.trim()).filter(Boolean);
  const focusColIndex = headerCells.findIndex((h) => h.toLowerCase() === "focus");
  // Session ID is always column 0
  const sessionColIndex = 0;

  const result = new Map<string, string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].trim();
    // Skip separator rows (e.g., |---|---|)
    if (/^\|[-| :]+\|$/.test(row)) continue;

    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    const sessionId = cells[sessionColIndex];
    if (!sessionId) continue;

    const focus = focusColIndex >= 0 && cells[focusColIndex]
      ? cells[focusColIndex]
      : cells[cells.length - 1] ?? "";

    result.set(sessionId, focus);
  }

  return result;
}

// ─── parseSessions ────────────────────────────────────────────────────────────

/**
 * Groups tasks into sessions based on their suggestedSession hint.
 * Tasks without a hint get an auto-generated single-task session.
 */
export function parseSessions(
  tasks: Task[],
  manifest: string,
): Session[] {
  const hintsTable = parseSessionHintsTable(manifest);

  // Group tasks by their session key
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.suggestedSession ?? `S-auto-T${task.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(task);
    } else {
      groups.set(key, [task]);
    }
  }

  const sessions: Session[] = [];

  for (const [id, groupTasks] of groups) {
    const complexity = groupTasks.reduce((sum, t) => sum + t.complexity, 0);
    const focus = hintsTable.get(id) ?? groupTasks.map((t) => t.title).join(", ");
    const anyBlocked = groupTasks.some((t) => t.status === "blocked");
    const status: SessionStatus = anyBlocked ? "blocked" : "queued";

    sessions.push({
      id,
      tasks: groupTasks,
      complexity,
      focus,
      status,
      bytesReceived: 0,
      turnCount: 0,
      lastLine: "",
      stage: "",
      attemptCount: 0,
    });
  }

  // Sort sessions by smallest task id in each session for stable ordering
  sessions.sort((a, b) => {
    const minA = Math.min(...a.tasks.map((t) => t.id));
    const minB = Math.min(...b.tasks.map((t) => t.id));
    return minA - minB;
  });

  return sessions;
}

// ─── Session Dependency Resolution ───────────────────────────────────────────

/**
 * For each session, collects all cross-session dependencies by inspecting
 * each task's `dependsOn` and checking if the referenced task lives in a
 * different session. Intra-session dependencies are ignored.
 *
 * Returns a map of session ID -> list of unique dependency session IDs.
 */
export function resolveSessionDependencies(sessions: Session[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (sessions.length === 0) return result;

  // Build a lookup: task ID -> session ID
  const taskOwner = new Map<number, string>();
  for (const session of sessions) {
    for (const task of session.tasks) {
      taskOwner.set(task.id, session.id);
    }
  }

  for (const session of sessions) {
    const depSessionIds = new Set<string>();
    for (const task of session.tasks) {
      for (const depId of task.dependsOn) {
        const ownerSessionId = taskOwner.get(depId);
        if (ownerSessionId !== undefined && ownerSessionId !== session.id) {
          depSessionIds.add(ownerSessionId);
        }
      }
    }
    result.set(session.id, [...depSessionIds]);
  }

  return result;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateManifest(tasks: Task[]): void {
  // Check for duplicate IDs
  const seen = new Set<number>();
  for (const t of tasks) {
    if (seen.has(t.id)) {
      throw new Error(`Duplicate task ID: ${t.id}`);
    }
    seen.add(t.id);
  }

  // Check for dangling dependency references
  for (const t of tasks) {
    for (const depId of t.dependsOn) {
      if (!seen.has(depId)) {
        throw new Error(
          `Task ${t.id} depends on Task ${depId}, which does not exist in the manifest`,
        );
      }
    }
  }

  // Warn about out-of-range complexity
  for (const t of tasks) {
    if (t.complexity < 0 || t.complexity > 10) {
      console.error(
        `\x1b[33mWarning: Task ${t.id} has complexity ${t.complexity} (expected 0\u201310)\x1b[0m`,
      );
    }
  }
}
