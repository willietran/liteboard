import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock node:fs ───────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// ─── Mock memory.js ─────────────────────────────────────────────────────────

vi.mock("../src/memory.js", () => ({
  readMemorySnapshot: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { readMemorySnapshot } from "../src/memory.js";
import { buildBrief, formatFixerErrors } from "../src/brief.js";
import type { Task, FixerErrorContext } from "../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const STUB_COMMANDS: Record<string, string> = {
  "agent-orientation.md": "# Agent Orientation\nYou are a spawned subagent.",
  "plan-review.md": "# Plan Review\nSpawn a review subagent.",
  "session-review.md": "# Session Review\nSpawn a review subagent for code.",
  "receiving-code-review.md": "# Receiving Code Review\nProcess feedback methodically.",
  "code-reviewer.md": "# Code Reviewer\nEvaluate code against criteria.",
  "quality-standards.md": "# Quality Standards\nEvery task must satisfy these standards.",
};

function stubReadFileSync() {
  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (filepath: string, _encoding?: string) => {
      for (const [name, content] of Object.entries(STUB_COMMANDS)) {
        if ((filepath as string).endsWith(name)) return content;
      }
      throw new Error(`Unexpected readFileSync call: ${filepath}`);
    },
  );
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 13,
    title: "Build brief assembler",
    creates: ["src/brief.ts"],
    modifies: [],
    dependsOn: [],
    requirements: ["Export buildBrief function", "Read commands/*.md files"],
    tddPhase: "RED → GREEN",
    commitMessage: "feat(brief): add brief assembler",
    complexity: 3,
    status: "queued",
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
    ...overrides,
  };
}

function makeDepTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 10,
    title: "Setup memory module",
    creates: ["src/memory.ts"],
    modifies: [],
    dependsOn: [],
    requirements: [],
    tddPhase: "RED → GREEN",
    commitMessage: "feat(memory): add memory module",
    complexity: 2,
    status: "done",
    stage: "",
    turnCount: 5,
    lastLine: "",
    bytesReceived: 1000,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("starts with agent-orientation.md content", () => {
    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    const lines = brief.split("\n");
    expect(lines[0]).toBe("# Agent Orientation");
    expect(brief).toContain("You are a spawned subagent.");
  });

  it("includes task context with ID, title, and slug", () => {
    const task = makeTask({ id: 7, title: "Parse manifest" });
    const brief = buildBrief(task, [task], "/home/user/my-project", "design.md", "manifest.json", "feat/parse");

    expect(brief).toContain("Task 7: Parse manifest");
    expect(brief).toContain("my-project");
  });

  it("includes design doc and manifest paths", () => {
    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "/path/to/design.md", "/path/to/manifest.json", "feat/brief");

    expect(brief).toContain("/path/to/design.md");
    expect(brief).toContain("/path/to/manifest.json");
  });

  it("injects memory snapshot when entries exist", () => {
    const memoryContent = "# Liteboard Memory Log\n\n## T10 - Setup - 2025-01-01\nDone setup.\n";
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue(memoryContent);

    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("Build Memory");
    expect(brief).toContain("## T10 - Setup");
    expect(brief).toContain("Done setup.");
  });

  it("omits memory snapshot when empty", () => {
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");

    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).not.toContain("Build Memory");
  });

  it("infers explore hints from creates and modifies", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/types.ts"],
    });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("Explore src/ for existing patterns");
  });

  it("infers explore hints from dependsOn tasks", () => {
    const depTask = makeDepTask({ id: 10, title: "Setup memory module", creates: ["src/memory.ts"] });
    const task = makeTask({ dependsOn: [10] });
    const allTasks = [depTask, task];

    const brief = buildBrief(task, allTasks, "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("Read src/memory.ts (created by Task 10: Setup memory module)");
  });

  it("includes task details: creates, modifies, requirements", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/types.ts"],
      requirements: ["Export buildBrief function", "Read commands/*.md files"],
    });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("Creates:");
    expect(brief).toContain("`src/brief.ts`");
    expect(brief).toContain("Modifies:");
    expect(brief).toContain("`src/types.ts`");
    expect(brief).toContain("Export buildBrief function");
    expect(brief).toContain("Read commands/*.md files");
  });

  it("includes commit message and rules at the end", () => {
    const task = makeTask({ commitMessage: "feat(brief): add brief assembler" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("feat(brief): add brief assembler");
    expect(brief).toContain("Do NOT touch files unrelated to this task");
    expect(brief).toContain("Do NOT push to remote");
    expect(brief).toContain("feat/brief");

    // Commit message and rules should appear after workflow
    const rulesIdx = brief.indexOf("## Rules");
    const workflowIdx = brief.indexOf("## Workflow");
    expect(rulesIdx).toBeGreaterThan(workflowIdx);
  });

  it("embeds all command files: plan-review, session-review, receiving-code-review, code-reviewer", () => {
    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("# Plan Review");
    expect(brief).toContain("Spawn a review subagent.");
    expect(brief).toContain("# Session Review");
    expect(brief).toContain("Spawn a review subagent for code.");
    expect(brief).toContain("# Receiving Code Review");
    expect(brief).toContain("Process feedback methodically.");
    expect(brief).toContain("# Code Reviewer");
    expect(brief).toContain("Evaluate code against criteria.");
  });

  it("deduplicates explore hints", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/other.ts"],
    });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    // Both files are in src/, so hint should appear only once
    const matches = brief.match(/Explore src\/ for existing patterns/g);
    expect(matches).toHaveLength(1);
  });

  it("includes TDD phase in workflow when set", () => {
    const task = makeTask({ tddPhase: "RED → GREEN" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("RED → GREEN");
  });

  it("throws descriptive error when a command file is missing", () => {
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (filepath: string) => {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${filepath}'`);
        err.code = "ENOENT";
        throw err;
      },
    );

    const task = makeTask();
    expect(() =>
      buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief"),
    ).toThrow(/Missing command file.*agent-orientation\.md.*Is liteboard installed correctly/);
  });

  it("omits TDD line when tddPhase is Exempt", () => {
    const task = makeTask({ tddPhase: "Exempt" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("TDD-Exempt");
    expect(brief).not.toContain("BLOCKING violation");
  });

  it("includes quality standards in every brief", () => {
    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("# Quality Standards");
    expect(brief).toContain("Every task must satisfy these standards.");
  });

  it("includes expanded TDD discipline for TDD tasks", () => {
    const task = makeTask({ tddPhase: "RED → GREEN" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("Write a failing test first");
    expect(brief).toContain("BLOCKING violation");
  });

  it("includes verification commands in rules section", () => {
    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");

    expect(brief).toContain("tsc --noEmit");
    expect(brief).toContain("npm run build");
    expect(brief).toContain("npm test");
  });
});

// ─── formatFixerErrors ──────────────────────────────────────────────────────

describe("formatFixerErrors", () => {
  it("formats passing build phase", () => {
    const ctx: FixerErrorContext = {
      buildResult: {
        success: true,
        failedPhase: "none",
        tscErrorCount: 0,
        testFailCount: 0,
        testPassCount: 5,
      },
    };
    const output = formatFixerErrors(ctx);
    expect(output).toContain("### Build Phase: PASSED");
  });

  it("formats failing build with tsc errors and stderr", () => {
    const ctx: FixerErrorContext = {
      buildResult: {
        success: false,
        failedPhase: "typecheck",
        tscErrorCount: 3,
        testFailCount: 0,
        testPassCount: 0,
        stderr: "src/foo.ts(1,1): error TS2304: cannot find name",
      },
    };
    const output = formatFixerErrors(ctx);
    expect(output).toContain("### Build Phase: FAILED at `typecheck`");
    expect(output).toContain("TypeScript errors: 3");
    expect(output).toContain("error TS2304");
  });

  it("formats failing build with test failures", () => {
    const ctx: FixerErrorContext = {
      buildResult: {
        success: false,
        failedPhase: "test",
        tscErrorCount: 0,
        testFailCount: 2,
        testPassCount: 10,
        stderr: "FAIL src/foo.test.ts",
      },
    };
    const output = formatFixerErrors(ctx);
    expect(output).toContain("Test failures: 2 (10 passed)");
  });

  it("formats failing smoke test with error details", () => {
    const ctx: FixerErrorContext = {
      buildResult: {
        success: true,
        failedPhase: "none",
        tscErrorCount: 0,
        testFailCount: 0,
        testPassCount: 5,
      },
      smokeResult: {
        success: false,
        projectType: "vite",
        error: "HTTP check returned 500",
        appUrl: "http://127.0.0.1:12345",
      },
    };
    const output = formatFixerErrors(ctx);
    expect(output).toContain("### Smoke Test: FAILED");
    expect(output).toContain("HTTP check returned 500");
    expect(output).toContain("http://127.0.0.1:12345");
  });

  it("formats QA failures with feature names", () => {
    const ctx: FixerErrorContext = {
      buildResult: {
        success: true,
        failedPhase: "none",
        tscErrorCount: 0,
        testFailCount: 0,
        testPassCount: 5,
      },
      qaReport: {
        features: [
          { name: "Login", passed: true },
          { name: "Task creation", passed: false, error: "Submit button broken" },
          { name: "Settings", passed: false, error: "Page not found" },
        ],
        totalPassed: 1,
        totalFailed: 2,
      },
    };
    const output = formatFixerErrors(ctx);
    expect(output).toContain("### QA Phase: 2 of 3 features failed");
    expect(output).toContain("[QA:FAIL] Task creation: Submit button broken");
    expect(output).toContain("[QA:FAIL] Settings: Page not found");
    expect(output).not.toContain("Login");
  });

  it("formats all-passing QA", () => {
    const ctx: FixerErrorContext = {
      buildResult: {
        success: true,
        failedPhase: "none",
        tscErrorCount: 0,
        testFailCount: 0,
        testPassCount: 5,
      },
      qaReport: {
        features: [{ name: "Login", passed: true }],
        totalPassed: 1,
        totalFailed: 0,
      },
    };
    const output = formatFixerErrors(ctx);
    expect(output).toContain("### QA Phase: PASSED (1 features verified)");
  });
});
