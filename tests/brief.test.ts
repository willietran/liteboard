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
import {
  buildBrief,
  buildArchitectBrief,
  buildImplementationBrief,
  buildSessionArchitectBrief,
  buildSessionImplementationBrief,
  buildSessionBrief,
  formatSubagentHints,
  buildManifestExcerpt,
} from "../src/brief.js";
import type { Task, Session, ModelConfig, Provider } from "../src/types.js";
import { defaultModelConfig } from "../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const STUB_COMMANDS: Record<string, string> = {
  "agent-orientation.md": "# Agent Orientation\nYou are a spawned subagent.",
  "architect-orientation.md": "# Architect Orientation\nYou are a spawned architect agent.",
  "plan-review.md": "# Plan Review\nSpawn a review subagent.",
  "session-review.md": "# Session Review\nSpawn a review subagent for code.",
  "receiving-code-review.md": "# Receiving Code Review\nProcess feedback methodically.",
  "code-reviewer.md": "# Code Reviewer\nEvaluate code against criteria.",
  "quality-standards.md": "# Quality Standards\nEvery task must satisfy these standards.",
  "verification.md": "# Verification\nRun `npx tsc --noEmit`, `npm run build`, `npm test` in a verification loop.",
  "qa-agent.md": "# QA Agent\nYou are a QA validation agent.",
  "shell-anti-patterns.md": "# Shell Anti-Patterns\nAvoid interactive CLI tools.",
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
    explore: [],
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
    explore: [],
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

function makeSession(overrides: Partial<Session> & { id: string; tasks: Task[] }): Session {
  return {
    focus: "Test session focus",
    complexity: 3,
    status: "queued",
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
    ...overrides,
  };
}

function mockProvider(): Provider {
  return {
    name: "claude",
    spawn: vi.fn() as any,
    parseStream: vi.fn() as any,
    createStreamParser: vi.fn() as any,
    healthCheck: vi.fn() as any,
    subagentModelHint(fullModel: string, providerName: string): string {
      if (providerName !== "claude") return "";
      if (fullModel.includes("opus")) return "opus";
      if (fullModel.includes("haiku")) return "haiku";
      return "sonnet";
    },
  };
}

function mockOllamaProvider(): Provider {
  return {
    name: "ollama",
    spawn: vi.fn() as any,
    parseStream: vi.fn() as any,
    createStreamParser: vi.fn() as any,
    healthCheck: vi.fn() as any,
    subagentModelHint(_fullModel: string, providerName: string): string {
      if (providerName !== "claude") return "";
      return "sonnet";
    },
  };
}

// ─── TEST_MANIFEST fixture ───────────────────────────────────────────────────

const TEST_MANIFEST = [
  "# Test Project — Task Manifest",
  "",
  "## Tech Stack",
  "",
  "| Concern | Choice |",
  "|---------|--------|",
  "| Runtime | Node.js 22+ |",
  "| Language | TypeScript |",
  "",
  "## Testing Strategy",
  "",
  "- All src/ modules have Vitest tests",
  "- Mock external dependencies",
  "",
  "---",
  "",
  "## Phase 1: Foundation",
  "",
  "### Task 1: Setup scaffolding",
  "",
  "- **Creates:** `package.json`, `tsconfig.json`",
  "- **Modifies:** (none)",
  "- **Depends on:** (none)",
  "- **Requirements:**",
  "  - Initialize npm package",
  "  - Configure TypeScript",
  "- **TDD Phase:** Exempt",
  "- **Complexity Score:** 2",
  "",
  "### Task 2: Core types",
  "",
  "- **Creates:** `src/types.ts`",
  "- **Modifies:** (none)",
  "- **Depends on:** Task 1",
  "- **Requirements:**",
  "  - Define shared interfaces",
  "  - Export all types",
  "- **TDD Phase:** RED → GREEN",
  "- **Complexity Score:** 3",
  "",
  "---",
  "",
  "## Phase 2: Implementation",
  "",
  "### Task 3: Parser module",
  "",
  "- **Creates:** `src/parser.ts`",
  "- **Modifies:** (none)",
  "- **Depends on:** Task 2",
  "- **Requirements:**",
  "  - Parse manifest markdown",
  "  - Return Task array",
  "- **TDD Phase:** RED → GREEN",
  "- **Complexity Score:** 4",
  "",
  "### Task 4: Integration",
  "",
  "- **Creates:** (none)",
  "- **Modifies:** `src/cli.ts`",
  "- **Depends on:** Task 2, Task 3",
  "- **Requirements:**",
  "  - Wire parser into CLI",
  "- **TDD Phase:** Exempt",
  "- **Complexity Score:** 3",
].join("\n");

// ─── formatSubagentHints ─────────────────────────────────────────────────────

describe("formatSubagentHints", () => {
  it("returns model hint lines for Claude provider", () => {
    const provider = mockProvider();
    const entries = [{ name: "Code Review", model: "claude-sonnet-4-6" }];
    const result = formatSubagentHints(entries, "claude", provider);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('- Code Review sub-agents: model: "sonnet"');
  });

  it("returns inherits-parent text for Ollama (empty hint)", () => {
    const provider = mockProvider();
    const entries = [{ name: "Code Review", model: "kimi-k2.5:cloud" }];
    const result = formatSubagentHints(entries, "ollama", provider);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("inherits parent model");
    expect(result[0]).toContain("do not specify a model parameter");
    expect(result[0]).not.toContain('model: ""');
  });

  it("handles multiple entries", () => {
    const provider = mockProvider();
    const entries = [
      { name: "Explore", model: "claude-sonnet-4-6" },
      { name: "Plan Review", model: "claude-opus-4-6" },
    ];
    const result = formatSubagentHints(entries, "claude", provider);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe('- Explore sub-agents: model: "sonnet"');
    expect(result[1]).toBe('- Plan Review sub-agents: model: "opus"');
  });

  it("returns empty array for empty entries", () => {
    const provider = mockProvider();
    const result = formatSubagentHints([], "claude", provider);

    expect(result).toEqual([]);
  });
});

// ─── buildImplementationBrief ────────────────────────────────────────────────

describe("buildImplementationBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("starts with agent-orientation.md content", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    const lines = brief.split("\n");
    expect(lines[0]).toBe("# Agent Orientation");
    expect(brief).toContain("You are a spawned subagent.");
  });

  it("includes task context with ID, title, and slug", () => {
    const task = makeTask({ id: 7, title: "Parse manifest" });
    const brief = buildImplementationBrief(task, [task], "/home/user/my-project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/parse");

    expect(brief).toContain("Task 7: Parse manifest");
    expect(brief).toContain("my-project");
  });

  it("inlines design doc and manifest content", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nThe design doc.", "# Manifest\nThe manifest.", "feat/brief");

    expect(brief).toContain("## Design Document");
    expect(brief).toContain("# Design");
    expect(brief).toContain("The design doc.");
    expect(brief).toContain("## Task Manifest");
    expect(brief).toContain("# Manifest");
    expect(brief).toContain("The manifest.");
  });

  it("injects memory snapshot when entries exist", () => {
    const memoryContent = "# Liteboard Memory Log\n\n## T10 - Setup - 2025-01-01\nDone setup.\n";
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue(memoryContent);

    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Build Memory");
    expect(brief).toContain("## T10 - Setup");
    expect(brief).toContain("Done setup.");
  });

  it("omits memory snapshot when empty", () => {
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");

    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Build Memory");
  });

  it("includes task details: creates, modifies, requirements", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/types.ts"],
      requirements: ["Export buildBrief function", "Read commands/*.md files"],
    });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Creates:");
    expect(brief).toContain("`src/brief.ts`");
    expect(brief).toContain("Modifies:");
    expect(brief).toContain("`src/types.ts`");
    expect(brief).toContain("Export buildBrief function");
    expect(brief).toContain("Read commands/*.md files");
  });

  it("includes commit message and rules at the end", () => {
    const task = makeTask({ commitMessage: "feat(brief): add brief assembler" });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("feat(brief): add brief assembler");
    expect(brief).toContain("Do NOT touch files unrelated to this task");
    expect(brief).toContain("Do NOT push to remote");
    expect(brief).toContain("feat/brief");

    // Commit message and rules should appear after workflow
    const rulesIdx = brief.indexOf("## Rules");
    const workflowIdx = brief.indexOf("## Workflow");
    expect(rulesIdx).toBeGreaterThan(workflowIdx);
  });

  it("includes session-review and code-reviewer but NOT plan-review", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("# Session Review");
    expect(brief).toContain("Spawn a review subagent for code.");
    expect(brief).toContain("# Receiving Code Review");
    expect(brief).toContain("# Code Reviewer");
    expect(brief).not.toContain("# Plan Review");
  });

  it("does NOT include explore hints", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/types.ts"],
    });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Explore src/ for existing patterns");
    expect(brief).not.toContain("Explore targets");
  });

  it("includes instruction to read task plan from artifacts dir", () => {
    const task = makeTask({ id: 13 });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("/fake/project/artifacts/t13-task-plan.md");
    expect(brief).toMatch(/[Rr]ead.*plan/);
  });

  it("includes plan read instruction for complexity > 2", () => {
    const task = makeTask({ complexity: 3 });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Task plan");
    expect(brief).toContain("task-plan.md");
  });

  it("skips plan read instruction for complexity 2", () => {
    const task = makeTask({ complexity: 2 });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Task plan");
    expect(brief).not.toContain("task-plan.md");
  });

  it("skips plan read instruction for complexity 1", () => {
    const task = makeTask({ complexity: 1 });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Task plan");
    expect(brief).not.toContain("task-plan.md");
  });

  it("skips plan read instruction for complexity 0", () => {
    const task = makeTask({ complexity: 0 });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Task plan");
    expect(brief).not.toContain("task-plan.md");
  });

  it("includes TDD phase in workflow when set", () => {
    const task = makeTask({ tddPhase: "RED → GREEN" });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

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
      buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief"),
    ).toThrow(/Missing command file.*agent-orientation\.md.*Is liteboard installed correctly/);
  });

  it("omits TDD line when tddPhase is Exempt", () => {
    const task = makeTask({ tddPhase: "Exempt" });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("TDD-Exempt");
    expect(brief).not.toContain("BLOCKING violation");
  });

  it("includes quality standards", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("# Quality Standards");
    expect(brief).toContain("Every task must satisfy these standards.");
  });

  it("includes expanded TDD discipline for TDD tasks", () => {
    const task = makeTask({ tddPhase: "RED → GREEN" });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Write a failing test first");
    expect(brief).toContain("BLOCKING violation");
  });

  it("includes verification phase", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("tsc --noEmit");
    expect(brief).toContain("npm run build");
    expect(brief).toContain("npm test");
  });

  it("includes artifacts path for memory entry in rules", () => {
    const task = makeTask({ id: 13 });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("/fake/project/artifacts/t13-memory-entry.md");
  });

  it("instructs agents to save artifacts outside repo root", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("never to the repo root");
  });
});

// ─── buildArchitectBrief ─────────────────────────────────────────────────────

describe("buildArchitectBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("starts with architect-orientation.md content", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    const lines = brief.split("\n");
    expect(lines[0]).toBe("# Architect Orientation");
    expect(brief).toContain("You are a spawned architect agent.");
  });

  it("does NOT use agent-orientation.md", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("You are a spawned subagent.");
  });

  it("includes plan-review but NOT session-review", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("# Plan Review");
    expect(brief).toContain("Spawn a review subagent.");
    expect(brief).not.toContain("# Session Review");
  });

  it("includes receiving-code-review but not code-reviewer in architect brief", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("# Receiving Code Review");
    expect(brief).not.toContain("# Code Reviewer");
  });

  it("includes explore targets (inferred from creates/modifies)", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/types.ts"],
    });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Explore src/ for existing patterns");
  });

  it("includes explore hints from dependency tasks", () => {
    const depTask = makeDepTask({ id: 10, title: "Setup memory module", creates: ["src/memory.ts"] });
    const task = makeTask({ dependsOn: [10] });
    const allTasks = [depTask, task];

    const brief = buildArchitectBrief(task, allTasks, "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Read src/memory.ts (created by Task 10: Setup memory module)");
  });

  it("deduplicates explore hints", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/other.ts"],
    });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    const matches = brief.match(/Explore src\/ for existing patterns/g);
    expect(matches).toHaveLength(1);
  });

  it("inlines design doc and manifest content", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nThe design doc.", "# Manifest\nThe manifest.", "feat/brief");

    expect(brief).toContain("## Design Document");
    expect(brief).toContain("# Design");
    expect(brief).toContain("The design doc.");
    expect(brief).toContain("## Task Manifest");
    expect(brief).toContain("# Manifest");
    expect(brief).toContain("The manifest.");
  });

  it("includes task context with ID, title, and slug", () => {
    const task = makeTask({ id: 7, title: "Parse manifest" });
    const brief = buildArchitectBrief(task, [task], "/home/user/my-project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/parse");

    expect(brief).toContain("Task 7: Parse manifest");
    expect(brief).toContain("my-project");
  });

  it("includes task details: creates, modifies, requirements", () => {
    const task = makeTask({
      creates: ["src/brief.ts"],
      modifies: ["src/types.ts"],
      requirements: ["Export buildBrief function"],
    });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("`src/brief.ts`");
    expect(brief).toContain("`src/types.ts`");
    expect(brief).toContain("Export buildBrief function");
  });

  it("includes quality standards", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("# Quality Standards");
    expect(brief).toContain("Every task must satisfy these standards.");
  });

  it("instructs to write plan to artifacts dir", () => {
    const task = makeTask({ id: 7 });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("/fake/project/artifacts/t7-task-plan.md");
    expect(brief).toMatch(/[Ww]rite.*plan/);
  });

  it("includes memory snapshot when present", () => {
    const memoryContent = "# Liteboard Memory Log\n\n## T10 - Setup - 2025-01-01\nDone setup.\n";
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue(memoryContent);

    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Build Memory");
    expect(brief).toContain("## T10 - Setup");
  });

  it("does NOT include verification phase", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("# Verification");
    expect(brief).not.toContain("tsc --noEmit");
  });

  it("does NOT include implementation or commit phases", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Phase 1: Implement");
    expect(brief).not.toContain("Phase 2: Verify");
    expect(brief).not.toContain("Phase 3: Code Review");
    expect(brief).not.toContain("Commit message");
  });

  it("includes memory entry path in rules", () => {
    const task = makeTask({ id: 7 });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("/fake/project/artifacts/t7-memory-entry.md");
  });

  it("includes feature branch in rules", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("feat/brief");
  });

  it("includes tool usage constraints", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Tool Usage Constraints");
    expect(brief).toContain("Do NOT use Bash to execute project code");
    expect(brief).toContain("node_modules is never installed in worktrees");
  });

  it("tool constraints appear after explore targets and before plan output", () => {
    const task = makeTask({ explore: ["How auth works"] });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    const constraintIdx = brief.indexOf("Tool Usage Constraints");
    const exploreIdx = brief.indexOf("How auth works");
    const planOutputIdx = brief.indexOf("### Plan Output");
    expect(constraintIdx).toBeGreaterThan(exploreIdx);
    expect(constraintIdx).toBeLessThan(planOutputIdx);
  });
});

// ─── buildBrief backward compatibility ───────────────────────────────────────

describe("buildBrief backward compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("dispatches to buildImplementationBrief for non-QA tasks", () => {
    const task = makeTask();
    const briefOld = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    const briefNew = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(briefOld).toBe(briefNew);
  });

  it("dispatches to buildQABrief for QA tasks", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("# QA Agent");
    expect(brief).toContain("QA agent");
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
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
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

    const brief = buildBrief(qaTask, allTasks, "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("Task 10: Add auth");
    expect(brief).toContain("User can sign up");
    expect(brief).toContain("User can log in");
    expect(brief).toContain("`src/auth.ts`");
    expect(brief).toContain("`src/app.ts`");
  });

  it("does NOT include plan-review or session-review workflow phases", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).not.toContain("# Plan Review");
    expect(brief).not.toContain("# Session Review");
    expect(brief).not.toContain("Phase 1-2");
    expect(brief).not.toContain("Phase 3: Implement");
    expect(brief).not.toContain("Phase 4: Code Review");
  });

  it("includes agent-orientation and quality-standards", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("# Agent Orientation");
    expect(brief).toContain("# Quality Standards");
  });

  it("identifies itself as QA agent in task context", () => {
    const task = makeTask({ id: 5, title: "Validate integration", type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("QA agent");
    expect(brief).toContain("Task 5: Validate integration");
  });

  it("includes qa-report artifact path in rules", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("/fake/project/artifacts/t13-qa-report.md");
    expect(brief).toContain("markdown table");
  });

  it("includes artifacts path for memory entry in rules", () => {
    const task = makeTask({ id: 20, type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("/fake/project/artifacts/t20-memory-entry.md");
  });

  it("instructs agents to save artifacts outside repo root", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");
    expect(brief).toContain("never to the repo root");
  });
});

// ─── Sub-Agent Model Injection ──────────────────────────────────────────────

describe("sub-agent model injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("implementation brief includes only codeReview hint", () => {
    const task = makeTask();
    const models = defaultModelConfig();
    const provider = mockProvider();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief", models, provider);

    expect(brief).toContain("## Sub-Agent Models");
    expect(brief).toContain('Code Review sub-agents: model: "sonnet"');
    expect(brief).not.toContain("Explore sub-agents");
    expect(brief).not.toContain("Plan Review sub-agents");
  });

  it("architect brief includes explore + planReview hints", () => {
    const task = makeTask();
    const models = defaultModelConfig();
    const provider = mockProvider();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief", models, provider);

    expect(brief).toContain("## Sub-Agent Models");
    expect(brief).toContain('Explore sub-agents: model: "sonnet"');
    expect(brief).toContain('Plan Review sub-agents: model: "opus"');
    expect(brief).not.toContain("Code Review sub-agents");
  });

  it("QA brief includes only fixer hint", () => {
    const task = makeTask({ type: "qa" });
    const models = defaultModelConfig();
    const provider = mockProvider();
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief", models, provider);

    expect(brief).toContain("## Sub-Agent Models");
    expect(brief).toContain('Fixer sub-agents: model: "opus"');
    expect(brief).not.toContain("Explore sub-agents");
    expect(brief).not.toContain("Plan Review sub-agents");
    expect(brief).not.toContain("Code Review sub-agents");
  });

  it("uses custom model hints when config overrides defaults", () => {
    const task = makeTask();
    const models = defaultModelConfig();
    models.implementation.subagents.codeReview = { model: "claude-haiku-4-5-20251001" };
    const provider = mockProvider();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief", models, provider);

    expect(brief).toContain('Code Review sub-agents: model: "haiku"');
  });

  it("omits Sub-Agent Models section when models/provider not provided", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("## Sub-Agent Models");
  });

  it("Ollama provider uses inherits-parent text instead of model hint", () => {
    const task = makeTask();
    const models = defaultModelConfig();
    models.implementation.provider = "ollama";
    const provider = mockOllamaProvider();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief", models, provider);

    expect(brief).toContain("## Sub-Agent Models");
    expect(brief).toContain("inherits parent model");
    expect(brief).toContain("do not specify a model parameter");
    expect(brief).not.toContain('model: ""');
  });

  it("architect brief with Ollama provider uses inherits-parent text", () => {
    const task = makeTask();
    const models = defaultModelConfig();
    models.architect.provider = "ollama";
    const provider = mockOllamaProvider();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief", models, provider);

    expect(brief).toContain("## Sub-Agent Models");
    expect(brief).toContain("inherits parent model");
    expect(brief).not.toContain('model: ""');
  });
});

// ─── Inline design doc + manifest ────────────────────────────────────────────

describe("inline design doc and manifest content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("implementation brief includes ## Design Document section with content", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("## Design Document");
    expect(brief).toContain("# Design");
    expect(brief).toContain("Full design content.");
  });

  it("implementation brief includes ## Task Manifest section with content", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("## Task Manifest");
    expect(brief).toContain("# Manifest");
    expect(brief).toContain("Full manifest content.");
  });

  it("implementation brief omits ## Design Document when designDoc is empty string", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("## Design Document");
  });

  it("implementation brief omits ## Task Manifest when manifest is empty string", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "", "feat/brief");

    expect(brief).not.toContain("## Task Manifest");
  });

  it("architect brief includes ## Design Document and ## Task Manifest", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design\nArch design.", "# Manifest\nArch manifest.", "feat/brief");

    expect(brief).toContain("## Design Document");
    expect(brief).toContain("# Design");
    expect(brief).toContain("Arch design.");
    expect(brief).toContain("## Task Manifest");
    expect(brief).toContain("# Manifest");
    expect(brief).toContain("Arch manifest.");
  });

  it("QA brief includes ## Design Document and ## Task Manifest", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "# Design\nQA design.", "# Manifest\nQA manifest.", "feat/brief");

    expect(brief).toContain("## Design Document");
    expect(brief).toContain("## Task Manifest");
  });
});

// ─── Explore targets ─────────────────────────────────────────────────────────

describe("explore targets in architect brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("uses manifest explore targets when present", () => {
    const task = makeTask({ explore: ["How auth works — for routing"] });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "", "# Manifest", "feat/brief");

    expect(brief).toContain("How auth works — for routing");
  });

  it("falls back to inferred hints when explore is empty and creates has paths", () => {
    const task = makeTask({ explore: [], creates: ["src/foo.ts"], modifies: [] });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "", "# Manifest", "feat/brief");

    expect(brief).toContain("Explore src/ for existing patterns");
  });

  it("uses only manifest targets when both explore items and creates paths exist", () => {
    const task = makeTask({ explore: ["How config loader works"], creates: ["src/foo.ts"], modifies: [] });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "", "# Manifest", "feat/brief");

    expect(brief).toContain("How config loader works");
    expect(brief).not.toContain("Explore src/ for existing patterns");
  });
});

// ─── Shell anti-patterns ─────────────────────────────────────────────────────

describe("shell anti-patterns inclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("implementation brief includes shell anti-patterns", () => {
    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "", "# Manifest", "feat/brief");

    expect(brief).toContain("# Shell Anti-Patterns");
  });

  it("QA brief includes shell anti-patterns", () => {
    const task = makeTask({ type: "qa" });
    const brief = buildBrief(task, [task], "/fake/project", "", "# Manifest", "feat/brief");

    expect(brief).toContain("# Shell Anti-Patterns");
  });

  it("architect brief does NOT include shell anti-patterns", () => {
    const task = makeTask();
    const brief = buildArchitectBrief(task, [task], "/fake/project", "", "# Manifest", "feat/brief");

    expect(brief).not.toContain("# Shell Anti-Patterns");
  });
});

// ─── buildManifestExcerpt ────────────────────────────────────────────────────

describe("buildManifestExcerpt", () => {
  it("includes the task's own entry", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).toContain("### Task 3: Parser module");
    expect(result).toContain("Parse manifest markdown");
  });

  it("includes direct dependency entries", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).toContain("### Task 2: Core types");
    expect(result).toContain("Define shared interfaces");
  });

  it("includes header sections", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).toContain("## Tech Stack");
    expect(result).toContain("Node.js 22+");
    expect(result).toContain("## Testing Strategy");
    expect(result).toContain("All src/ modules have Vitest tests");
  });

  it("includes one-line summary with total task count", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).toContain("4 tasks");
  });

  it("excludes unrelated tasks", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).not.toContain("### Task 1: Setup scaffolding");
    expect(result).not.toContain("### Task 4: Integration");
  });

  it("works with tasks that have no dependencies", () => {
    const task = makeTask({ id: 1, dependsOn: [] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).toContain("### Task 1: Setup scaffolding");
    expect(result).not.toContain("### Task 2");
    expect(result).not.toContain("### Task 3");
    expect(result).not.toContain("### Task 4");
  });

  it("includes only direct dependencies, not transitive", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    // Task 2 depends on Task 1, but task 3 only directly depends on task 2
    expect(result).toContain("### Task 2:");
    expect(result).not.toContain("### Task 1:");
  });

  it("returns empty string for empty manifest", () => {
    const task = makeTask();
    const result = buildManifestExcerpt(task, "");

    expect(result).toBe("");
  });

  it("handles manifest with no task entries gracefully", () => {
    const task = makeTask();
    const result = buildManifestExcerpt(task, "# Simple Manifest\nSome content");

    expect(result).toContain("# Simple Manifest");
    expect(result).toContain("Some content");
  });

  it("summary line omits phase when task ID is not in manifest", () => {
    const task = makeTask({ id: 99, dependsOn: [] });
    const result = buildManifestExcerpt(task, TEST_MANIFEST);

    expect(result).toContain("4 tasks");
    expect(result).not.toContain("Phase 1");
    expect(result).not.toContain("Phase 2");
  });
});

// ─── Manifest excerpt integration ────────────────────────────────────────────

describe("manifest excerpt integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("architect brief uses manifest excerpt, excludes unrelated tasks", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design", TEST_MANIFEST, "feat/brief");

    expect(brief).toContain("### Task 3: Parser module");
    expect(brief).toContain("### Task 2: Core types");
    expect(brief).not.toContain("### Task 1: Setup scaffolding");
    expect(brief).not.toContain("### Task 4: Integration");
  });

  it("implementation brief uses manifest excerpt, excludes unrelated tasks", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design", TEST_MANIFEST, "feat/brief");

    expect(brief).toContain("### Task 3: Parser module");
    expect(brief).toContain("### Task 2: Core types");
    expect(brief).not.toContain("### Task 1: Setup scaffolding");
    expect(brief).not.toContain("### Task 4: Integration");
  });

  it("architect brief still includes design doc verbatim", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const brief = buildArchitectBrief(task, [task], "/fake/project", "# Design Doc\nFull design content here.", TEST_MANIFEST, "feat/brief");

    expect(brief).toContain("## Design Document");
    expect(brief).toContain("Full design content here.");
  });

  it("briefs handle empty manifest without error", () => {
    const task = makeTask({ id: 3, dependsOn: [2] });
    const architectBrief = buildArchitectBrief(task, [task], "/fake/project", "# Design", "", "feat/brief");
    const implBrief = buildImplementationBrief(task, [task], "/fake/project", "# Design", "", "feat/brief");

    expect(architectBrief).not.toContain("## Task Manifest");
    expect(implBrief).not.toContain("## Task Manifest");
  });
});

// ─── appendMemorySnapshot regex — S{id} entries ──────────────────────────────

describe("appendMemorySnapshot — S{id} entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
  });

  it("includes memory when it contains ## S1 session entries", () => {
    const memoryContent = "# Liteboard Memory Log\n\n## S1 - Types/config - 2026-03-13\nCompleted session S1.\n";
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue(memoryContent);

    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Build Memory");
    expect(brief).toContain("## S1 - Types/config");
    expect(brief).toContain("Completed session S1.");
  });

  it("includes memory when it contains both ## T{id} and ## S{id} entries", () => {
    const memoryContent = "# Liteboard Memory Log\n\n## T5 - Setup - 2026-03-10\nOld task.\n\n## S1 - Types - 2026-03-13\nNew session.\n";
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue(memoryContent);

    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).toContain("Build Memory");
    expect(brief).toContain("## T5 - Setup");
    expect(brief).toContain("## S1 - Types");
  });

  it("omits memory when it has no ## T{id} or ## S{id} entries", () => {
    const memoryContent = "# Liteboard Memory Log\n\nNo entries yet.\n";
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue(memoryContent);

    const task = makeTask();
    const brief = buildImplementationBrief(task, [task], "/fake/project", "# Design\nFull design content.", "# Manifest\nFull manifest content.", "feat/brief");

    expect(brief).not.toContain("Build Memory");
  });
});

// ─── buildSessionArchitectBrief ──────────────────────────────────────────────

describe("buildSessionArchitectBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("starts with architect-orientation.md content", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types and config" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    const lines = brief.split("\n");
    expect(lines[0]).toBe("# Architect Orientation");
  });

  it("includes session ID in plan output instruction", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S2", tasks: [task], focus: "Core types" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("/fake/project/artifacts/sS2-session-plan.md");
    expect(brief).toMatch(/[Ww]rite.*plan/);
  });

  it("includes session focus in task context line", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types and config" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Session S1: Types and config");
  });

  it("includes all task titles in the brief", () => {
    const task1 = makeTask({ id: 1, title: "Setup types" });
    const task2 = makeTask({ id: 2, title: "Setup config" });
    const session = makeSession({ id: "S1", tasks: [task1, task2], focus: "Foundation" });
    const brief = buildSessionArchitectBrief(session, [task1, task2], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Task 1: Setup types");
    expect(brief).toContain("Task 2: Setup config");
  });

  it("includes all task requirements in the brief", () => {
    const task = makeTask({
      id: 1,
      title: "Setup types",
      requirements: ["Define Task interface", "Export all types"],
    });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Define Task interface");
    expect(brief).toContain("Export all types");
  });

  it("includes memory entry path in rules with session ID", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S3", tasks: [task], focus: "Types" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("/fake/project/artifacts/sS3-memory-entry.md");
  });

  it("includes tool usage constraints", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Tool Usage Constraints");
    expect(brief).toContain("Do NOT use Bash to execute project code");
  });

  it("does NOT include implementation phases or commit messages", () => {
    const task = makeTask({ id: 1, title: "Setup types", commitMessage: "feat: setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionArchitectBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).not.toContain("Phase 1: Implement");
    expect(brief).not.toContain("Phase 2: Verify");
    expect(brief).not.toContain("Commit message");
    expect(brief).not.toContain("feat: setup types");
  });
});

// ─── buildSessionImplementationBrief ─────────────────────────────────────────

describe("buildSessionImplementationBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("starts with agent-orientation.md content", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types and config" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    const lines = brief.split("\n");
    expect(lines[0]).toBe("# Agent Orientation");
  });

  it("includes session ID in plan path", () => {
    const task = makeTask({ id: 1, title: "Setup types", complexity: 3 });
    const session = makeSession({ id: "S2", tasks: [task], focus: "Core types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("/fake/project/artifacts/sS2-session-plan.md");
  });

  it("skips plan path when all tasks have complexity <= LOW_COMPLEXITY_THRESHOLD", () => {
    const task = makeTask({ id: 1, title: "Setup types", complexity: 1 });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).not.toContain("session-plan.md");
  });

  it("includes session focus in task context line", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types and config" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Session S1: Types and config");
  });

  it("includes all task titles in the brief", () => {
    const task1 = makeTask({ id: 1, title: "Setup types" });
    const task2 = makeTask({ id: 2, title: "Setup config" });
    const session = makeSession({ id: "S1", tasks: [task1, task2], focus: "Foundation" });
    const brief = buildSessionImplementationBrief(session, [task1, task2], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Task 1: Setup types");
    expect(brief).toContain("Task 2: Setup config");
  });

  it("includes commit messages for each task", () => {
    const task1 = makeTask({ id: 1, title: "Setup types", commitMessage: "feat: add types" });
    const task2 = makeTask({ id: 2, title: "Setup config", commitMessage: "feat: add config" });
    const session = makeSession({ id: "S1", tasks: [task1, task2], focus: "Foundation" });
    const brief = buildSessionImplementationBrief(session, [task1, task2], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("feat: add types");
    expect(brief).toContain("feat: add config");
  });

  it("includes all task requirements in the brief", () => {
    const task = makeTask({
      id: 1,
      title: "Setup types",
      requirements: ["Define Task interface", "Export all types"],
    });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("Define Task interface");
    expect(brief).toContain("Export all types");
  });

  it("includes memory entry path in rules with session ID", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S4", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("/fake/project/artifacts/sS4-memory-entry.md");
  });

  it("includes TDD instruction when session has TDD tasks", () => {
    const task = makeTask({ id: 1, title: "Setup types", tddPhase: "RED → GREEN" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("This session contains TDD tasks");
    expect(brief).toContain("RED");
    expect(brief).toContain("GREEN");
  });

  it("uses TDD-Exempt message when no task has a TDD phase", () => {
    const task = makeTask({ id: 1, title: "Setup types", tddPhase: "Exempt" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("TDD-Exempt");
    expect(brief).not.toContain("This session contains TDD tasks");
  });

  it("includes session-review and code-reviewer but NOT plan-review", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("# Session Review");
    expect(brief).toContain("# Code Reviewer");
    expect(brief).not.toContain("# Plan Review");
  });

  it("includes feature branch in rules", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionImplementationBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/my-feature");

    expect(brief).toContain("feat/my-feature");
  });
});

// ─── buildSessionBrief dispatcher ────────────────────────────────────────────

describe("buildSessionBrief dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReadFileSync();
    (readMemorySnapshot as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("dispatches to implementation brief for non-QA sessions", () => {
    const task = makeTask({ id: 1, title: "Setup types" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "Types" });
    const brief = buildSessionBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("# Agent Orientation");
    expect(brief).not.toContain("# QA Agent");
  });

  it("dispatches to QA brief when all tasks have type qa", () => {
    const task = makeTask({ id: 1, title: "Validate feature", type: "qa" });
    const session = makeSession({ id: "S1", tasks: [task], focus: "QA" });
    const brief = buildSessionBrief(session, [task], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    expect(brief).toContain("# QA Agent");
  });

  it("dispatches to implementation brief when session has mixed task types", () => {
    const implTask = makeTask({ id: 1, title: "Implement feature" });
    const qaTask = makeTask({ id: 2, title: "QA feature", type: "qa" });
    const session = makeSession({ id: "S1", tasks: [implTask, qaTask], focus: "Mixed" });
    const brief = buildSessionBrief(session, [implTask, qaTask], "/fake/project", "# Design\nContent.", "# Manifest\nContent.", "feat/branch");

    // Not all tasks are QA, so uses implementation brief
    expect(brief).toContain("# Agent Orientation");
  });
});
