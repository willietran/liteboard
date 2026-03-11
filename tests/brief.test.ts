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
import { buildBrief } from "../src/brief.js";
import type { Task } from "../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const STUB_COMMANDS: Record<string, string> = {
  "agent-orientation.md": "# Agent Orientation\nYou are a spawned subagent.",
  "plan-review.md": "# Plan Review\nSpawn a review subagent.",
  "session-review.md": "# Session Review\nSpawn a review subagent for code.",
  "receiving-code-review.md": "# Receiving Code Review\nProcess feedback methodically.",
  "code-reviewer.md": "# Code Reviewer\nEvaluate code against criteria.",
  "quality-standards.md": "# Quality Standards\nEvery task must satisfy these standards.",
  "qa-agent.md": "# QA Agent\nYou are a QA validation agent.",
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

  it("includes artifacts path for memory entry in rules", () => {
    const task = makeTask({ id: 13 });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("/fake/project/artifacts/t13-memory-entry.md");
  });

  it("instructs agents to save artifacts outside repo root", () => {
    const task = makeTask();
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("never to the repo root");
  });
});

// ─── QA brief ────────────────────────────────────────────────────────────────

describe("buildBrief for QA tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("includes qa-agent.md content for type: qa", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("# QA Agent");
    expect(brief).toContain("You are a QA validation agent.");
  });

  it("includes dependent task requirements", () => {
    const depTask = makeDepTask({
      id: 10,
      title: "Add auth",
      creates: ["src/auth.ts"],
      modifies: ["src/app.ts"],
      requirements: ["User can sign up", "User can log in"],
    });
    const qaTask = makeTask({ id: 20, type: "qa", dependsOn: [10] });
    const allTasks = [depTask, qaTask];

    const brief = buildBrief(qaTask, allTasks, "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("Task 10: Add auth");
    expect(brief).toContain("User can sign up");
    expect(brief).toContain("User can log in");
    expect(brief).toContain("`src/auth.ts`");
    expect(brief).toContain("`src/app.ts`");
  });

  it("does NOT include plan-review or session-review workflow phases", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).not.toContain("# Plan Review");
    expect(brief).not.toContain("# Session Review");
    expect(brief).not.toContain("Phase 1-2");
    expect(brief).not.toContain("Phase 3: Implement");
    expect(brief).not.toContain("Phase 4: Code Review");
  });

  it("includes agent-orientation and quality-standards", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("# Agent Orientation");
    expect(brief).toContain("# Quality Standards");
  });

  it("identifies itself as QA agent in task context", () => {
    const task = makeTask({ id: 5, title: "Validate integration", type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("QA agent");
    expect(brief).toContain("Task 5: Validate integration");
  });

  it("includes qa-report artifact path in rules", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("/fake/project/artifacts/t13-qa-report.md");
    expect(brief).toContain("markdown table");
  });

  it("includes artifacts path for memory entry in rules", () => {
    const task = makeTask({ id: 20, type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("/fake/project/artifacts/t20-memory-entry.md");
  });

  it("instructs agents to save artifacts outside repo root", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "design.md", "manifest.json", "feat/brief");
    expect(brief).toContain("never to the repo root");
  });
});
