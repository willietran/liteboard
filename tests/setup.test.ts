import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock("node:url", () => ({
  fileURLToPath: vi.fn(() => "/fake/dist/setup.js"),
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { findClaudeConfigDir, runSetup } from "../src/setup.js";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockCopyFileSync = vi.mocked(fs.copyFileSync);

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Suppress console output during tests
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── findClaudeConfigDir ────────────────────────────────────────────────────

describe("findClaudeConfigDir", () => {
  it("returns path when ~/.claude/ exists", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/testuser";
    mockExistsSync.mockReturnValue(true);

    const result = findClaudeConfigDir();

    expect(result).toBe("/Users/testuser/.claude");
    expect(mockExistsSync).toHaveBeenCalledWith("/Users/testuser/.claude");

    process.env.HOME = originalHome;
  });

  it("returns null when HOME env var is not set", () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    const result = findClaudeConfigDir();

    expect(result).toBeNull();

    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it("returns null when ~/.claude/ does not exist", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/testuser";
    mockExistsSync.mockReturnValue(false);

    const result = findClaudeConfigDir();

    expect(result).toBeNull();

    process.env.HOME = originalHome;
  });
});

// ─── runSetup ───────────────────────────────────────────────────────────────

describe("runSetup", () => {
  it("throws when claude CLI is not found", () => {
    mockExec.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(() => runSetup()).toThrow("Claude Code CLI not found");
  });

  it("throws when Claude config dir is not found", () => {
    const originalHome = process.env.HOME;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    // which claude succeeds
    mockExec.mockReturnValue(Buffer.from("/usr/local/bin/claude"));

    expect(() => runSetup()).toThrow("Could not find Claude Code config directory");

    process.env.HOME = originalHome;
  });

  it("copies skill files with liteboard: prefix", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/testuser";

    // which claude succeeds
    mockExec.mockReturnValue(Buffer.from("/usr/local/bin/claude"));
    // existsSync: ~/.claude exists, skills source exists, commands dir exists
    mockExistsSync.mockReturnValue(true);
    // readdirSync returns skill files
    mockReaddirSync.mockReturnValue(
      ["brainstorm.md", "task-manifest.md", "run.md"] as unknown as ReturnType<typeof fs.readdirSync>,
    );

    runSetup();

    // Should copy each skill file with liteboard: prefix
    expect(mockCopyFileSync).toHaveBeenCalledTimes(3);

    // Verify the destination paths include liteboard: prefix
    const destPaths = mockCopyFileSync.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(destPaths).toContainEqual(
      expect.stringContaining("liteboard:brainstorm.md"),
    );
    expect(destPaths).toContainEqual(
      expect.stringContaining("liteboard:task-manifest.md"),
    );
    expect(destPaths).toContainEqual(
      expect.stringContaining("liteboard:run.md"),
    );

    process.env.HOME = originalHome;
  });

  it("creates commands directory if it does not exist", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/testuser";

    // which claude succeeds
    mockExec.mockReturnValue(Buffer.from("/usr/local/bin/claude"));
    // existsSync: ~/.claude exists (1st call), skills source exists (2nd),
    // commands dir does NOT exist (3rd)
    mockExistsSync
      .mockReturnValueOnce(true)   // ~/.claude
      .mockReturnValueOnce(true)   // skills source
      .mockReturnValueOnce(false); // commands dir
    // readdirSync returns skill files
    mockReaddirSync.mockReturnValue(
      ["brainstorm.md"] as unknown as ReturnType<typeof fs.readdirSync>,
    );

    runSetup();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/Users/testuser/.claude/commands",
      { recursive: true },
    );

    process.env.HOME = originalHome;
  });
});
