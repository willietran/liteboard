import { readFileSync } from "node:fs";
import type { Task, TddPhase } from "./types.js";

const VALID_TDD_PHASES: ReadonlySet<string> = new Set([
  "RED", "GREEN", "RED \u2192 GREEN", "Exempt",
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

function parseRequirements(section: string): string[] {
  const headerMatch = section.match(/\*\*Requirements:\*\*/i);
  if (!headerMatch) return [];

  const afterHeader = section.slice(
    headerMatch.index! + headerMatch[0].length,
  );

  const requirements: string[] = [];
  const lines = afterHeader.split("\n");

  for (const line of lines) {
    // Stop at the next bold field or section header
    if (/^\*\*\w/.test(line.trim()) || /^###\s/.test(line.trim())) break;

    // Match bullet lines (top-level or sub-bullets)
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (bulletMatch) {
      requirements.push(bulletMatch[1].trim());
    }
  }

  return requirements;
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

    const task: Task = {
      id: headers[i].id,
      title: headers[i].title,
      creates: parseFileList(section, "Creates"),
      modifies: parseFileList(section, "Modifies"),
      dependsOn,
      requirements: parseRequirements(section),
      tddPhase: normalizeTddPhase(parseSingleValue(section, "TDD Phase")),
      commitMessage: parseSingleValue(section, "Commit"),
      complexity: isNaN(complexity) ? 0 : complexity,
      status: dependsOn.length === 0 ? "queued" : "blocked",
      stage: "",
      turnCount: 0,
      lastLine: "",
      bytesReceived: 0,
    };

    tasks.push(task);
  }

  validateManifest(tasks);
  return tasks;
}

// ─── TDD Phase Normalization ────────────────────────────────────────────────

function normalizeTddPhase(raw: string): TddPhase {
  if (!raw) return "";
  if (VALID_TDD_PHASES.has(raw)) return raw as TddPhase;
  // Try uppercase normalization
  const upper = raw.toUpperCase();
  for (const valid of VALID_TDD_PHASES) {
    if (upper === valid.toUpperCase()) return valid as TddPhase;
  }
  return "";
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
        `\x1b[33mWarning: Task ${t.id} has complexity ${t.complexity} (expected 0–10)\x1b[0m`,
      );
    }
  }
}
