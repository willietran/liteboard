import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendMemoryEntry } from "../src/memory.js";

// ─── Concurrency integration test (real fs, real temp dir) ──────────────────

describe("appendMemoryEntry concurrency (real fs)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "liteboard-mem-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serializes multiple concurrent appends without corruption", async () => {
    const count = 10;
    const promises: Promise<void>[] = [];
    for (let i = 1; i <= count; i++) {
      promises.push(appendMemoryEntry(tmpDir, String(i), `Session ${i} focus`, `Body for session ${i}.`));
    }
    await Promise.all(promises);

    const content = readFileSync(join(tmpDir, "memory.md"), "utf-8");

    // Header present
    expect(content).toContain("# Liteboard Memory Log");

    // All entries present
    for (let i = 1; i <= count; i++) {
      expect(content).toContain(`S${i} - Session ${i} focus`);
      expect(content).toContain(`Body for session ${i}.`);
    }

    // Count entry headings — should be exactly `count`
    const headings = content.match(/^## S\d+/gm);
    expect(headings).toHaveLength(count);
  });
});
