import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock node:fs ───────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { appendMemoryEntry, readMemorySnapshot } from "../src/memory.js";

// ─── appendMemoryEntry (mocked) ─────────────────────────────────────────────

describe("appendMemoryEntry (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates memory.md with header if the file does not exist", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await appendMemoryEntry("/fake/project", 1, "Setup DB", "Created schema.");

    expect(writeFileSync).toHaveBeenCalled();
    const writtenContent = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(writtenContent).toContain("# Liteboard Memory Log");
  });

  it("appends entry with correct format: ## T<id> - <title> - <ISO timestamp> followed by body", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await appendMemoryEntry("/fake/project", 42, "Add auth", "JWT tokens configured.");

    const writtenContent = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(writtenContent).toMatch(/## T42 - Add auth - \d{4}-\d{2}-\d{2}T/);
    expect(writtenContent).toContain("JWT tokens configured.");
  });

  it("uses atomic write via temp file + rename", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await appendMemoryEntry("/fake/project", 1, "Task", "Body");

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const tempPath = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tempPath).toContain("memory.md.tmp");

    expect(renameSync).toHaveBeenCalledTimes(1);
    const [src, dest] = (renameSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(src).toBe(tempPath);
    expect((dest as string).endsWith("memory.md")).toBe(true);
  });

  it("entry format includes task id, title, and timestamp", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("# Liteboard Memory Log\n\n");

    await appendMemoryEntry("/fake/project", 7, "Deploy API", "Deployed to staging.");

    const writtenContent = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(writtenContent).toContain("T7");
    expect(writtenContent).toContain("Deploy API");
    expect(writtenContent).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(writtenContent).toContain("Deployed to staging.");
  });
});

// ─── readMemorySnapshot (mocked) ────────────────────────────────────────────

describe("readMemorySnapshot (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty string for non-existent file", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = readMemorySnapshot("/fake/project");

    expect(result).toBe("");
  });

  it("returns content of memory.md", () => {
    const content = "# Liteboard Memory Log\n\n## T1 - Init - 2025-01-01T00:00:00.000Z\nDone.\n";
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(content);

    const result = readMemorySnapshot("/fake/project");

    expect(result).toBe(content);
  });
});
