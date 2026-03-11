import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
}));

vi.mock("../src/brief.js", () => ({
  readCommand: vi.fn(() => "# QA Agent"),
}));

import * as fs from "node:fs";
import { isPlaywrightMCPAvailable, parseQAReport, buildQABrief } from "../src/qa.js";
import type { Task } from "../src/types.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

// ─── isPlaywrightMCPAvailable ────────────────────────────────────────────────

describe("isPlaywrightMCPAvailable", () => {
  it("returns true when playwright is in mcpServers in ~/.claude.json", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }),
    );
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns true when playwright is in ~/.claude/settings.json", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("settings.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }),
    );
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns true by default (built-in plugin) when no config exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns true when config exists but no playwright in mcpServers (built-in plugin)", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { other: { command: "test" } } }),
    );
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns false when playwright is disabled for the most specific project path", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          "/my/project": {
            disabledMcpServers: ["plugin:playwright:playwright"],
          },
        },
      }),
    );
    expect(isPlaywrightMCPAvailable("/my/project")).toBe(false);
  });

  it("returns true when parent has playwright disabled but specific project does not", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          "/my": {
            disabledMcpServers: ["plugin:playwright:playwright"],
          },
          "/my/project": {},
        },
      }),
    );
    // Most specific match (/my/project) has no disabled list — built-in available
    expect(isPlaywrightMCPAvailable("/my/project")).toBe(true);
  });

  it("returns true when playwright is explicitly configured at project level", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          "/my/project": {
            mcpServers: { playwright: { command: "npx" } },
          },
        },
      }),
    );
    expect(isPlaywrightMCPAvailable("/my/project")).toBe(true);
  });

  it("returns true on malformed config (fail-open for built-in plugin)", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue("not json");
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });
});

// ─── parseQAReport ───────────────────────────────────────────────────────────

describe("parseQAReport", () => {
  it("parses PASS markers", () => {
    const output = "[QA:PASS] User registration\n[QA:PASS] Dashboard";
    const report = parseQAReport(output);

    expect(report.totalPassed).toBe(2);
    expect(report.totalFailed).toBe(0);
    expect(report.features).toHaveLength(2);
    expect(report.features[0]).toEqual({ name: "User registration", passed: true });
  });

  it("parses FAIL markers with error description", () => {
    const output = "[QA:FAIL] Task creation: Submit button broken";
    const report = parseQAReport(output);

    expect(report.totalFailed).toBe(1);
    expect(report.features[0]).toEqual({
      name: "Task creation",
      passed: false,
      error: "Submit button broken",
    });
  });

  it("parses mixed PASS and FAIL markers", () => {
    const output = [
      "[QA:PASS] Login",
      "Some random text",
      "[QA:FAIL] Settings: Page not found",
      "[QA:PASS] Logout",
    ].join("\n");

    const report = parseQAReport(output);
    expect(report.totalPassed).toBe(2);
    expect(report.totalFailed).toBe(1);
    expect(report.features).toHaveLength(3);
  });

  it("returns empty report for output with no markers", () => {
    const report = parseQAReport("no markers here");
    expect(report.totalPassed).toBe(0);
    expect(report.totalFailed).toBe(0);
    expect(report.features).toHaveLength(0);
  });

  it("handles FAIL without error description", () => {
    const output = "[QA:FAIL] Broken feature";
    const report = parseQAReport(output);

    expect(report.totalFailed).toBe(1);
    expect(report.features[0]).toEqual({
      name: "Broken feature",
      passed: false,
    });
  });
});

// ─── buildQABrief ────────────────────────────────────────────────────────────

describe("buildQABrief", () => {
  it("includes app URL in brief", () => {
    const tasks: Task[] = [
      {
        id: 1,
        title: "Add login",
        creates: [],
        modifies: [],
        dependsOn: [],
        requirements: ["User can sign up", "User can log in"],
        tddPhase: "",
        commitMessage: "",
        complexity: 1,
        status: "done",
        stage: "",
        turnCount: 0,
        lastLine: "",
        bytesReceived: 0,
      },
    ];

    const brief = buildQABrief(tasks, "/project", "http://localhost:12345");

    expect(brief).toContain("http://localhost:12345");
  });

  it("includes task requirements in brief", () => {
    const tasks: Task[] = [
      {
        id: 1,
        title: "Add login",
        creates: [],
        modifies: [],
        dependsOn: [],
        requirements: ["User can sign up"],
        tddPhase: "",
        commitMessage: "",
        complexity: 1,
        status: "done",
        stage: "",
        turnCount: 0,
        lastLine: "",
        bytesReceived: 0,
      },
    ];

    const brief = buildQABrief(tasks, "/project", "http://localhost:3000");

    expect(brief).toContain("Task 1: Add login");
    expect(brief).toContain("User can sign up");
  });
});
