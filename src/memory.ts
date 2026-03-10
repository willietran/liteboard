import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createMutex } from "./mutex.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_FILE = "memory.md";
const HEADER = "# Liteboard Memory Log\n\n";

// ─── Mutex ──────────────────────────────────────────────────────────────────

const serialize = createMutex();

// ─── appendMemoryEntry ──────────────────────────────────────────────────────

export async function appendMemoryEntry(
  projectDir: string,
  taskId: number,
  title: string,
  body: string,
): Promise<void> {
  return serialize(async () => {
    const memoryPath = join(projectDir, MEMORY_FILE);
    const tempPath = join(projectDir, `${MEMORY_FILE}.tmp`);

    // Read existing content or initialize with header
    let existing: string;
    if (existsSync(memoryPath)) {
      existing = readFileSync(memoryPath, "utf-8");
    } else {
      mkdirSync(dirname(memoryPath), { recursive: true });
      existing = HEADER;
    }

    // Build the new entry
    const timestamp = new Date().toISOString();
    const entry = `## T${taskId} - ${title} - ${timestamp}\n\n${body}\n\n`;

    const content = existing + entry;

    // Atomic write: write to temp file, then rename
    writeFileSync(tempPath, content, "utf-8");
    renameSync(tempPath, memoryPath);
  });
}

// ─── readMemorySnapshot ─────────────────────────────────────────────────────

export function readMemorySnapshot(projectDir: string): string {
  const memoryPath = join(projectDir, MEMORY_FILE);
  if (!existsSync(memoryPath)) {
    return "";
  }
  return readFileSync(memoryPath, "utf-8");
}
