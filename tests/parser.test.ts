import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseManifest, parseSessions } from "../src/parser.js";
import type { Task, Session } from "../src/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_MANIFEST = `
# Task Manifest

## Overview
This manifest describes all tasks for the feature branch.

### Task 1: Set up project scaffolding

**Creates:** \`src/index.ts\`, \`src/config.ts\`
**Modifies:** (none)
**Depends on:** (none)
**Requirements:**
- Initialize the project structure
- Create entry point with CLI argument parsing
  - Support \`--verbose\` flag
  - Support \`--config\` flag
- Add config loader module

**TDD Phase:** GREEN
**Commit:** feat: scaffold project with CLI entry and config loader
**Complexity Score:** 3

### Task 2: Implement database layer

**Creates:** \`src/db.ts\`
**Modifies:** \`src/config.ts\`, \`src/index.ts\`
**Depends on:** Task 1
**Requirements:**
- Create database connection module
- Add migration runner
- Wire into config and entry point
**Explore:**
- How the config loader discovers files — for wiring database config
- What CLI argument patterns exist — for adding new flags

**TDD Phase:** RED
**Commit:** feat: add database layer with migrations
**Complexity Score:** 5

### Task 3: Add API routes

**Creates:** \`src/routes.ts\`, \`src/middleware.ts\`
**Modifies:** \`src/index.ts\`
**Depends on:** Task 1, Task 2
**Requirements:**
- Create REST endpoints for CRUD operations
- Add authentication middleware
- Register routes in entry point

**TDD Phase:** RED
**Commit:** feat: add REST API routes with auth middleware
**Complexity Score:** 8
`.trimStart();

const MALFORMED_MANIFEST = `
# Broken Manifest

### Task 1: Minimal task

**Requirements:**
- Just one thing

### Task 2: Another minimal task

**Creates:** \`src/foo.ts\`
**Depends on:** Task 1

`.trimStart();

// ─── Test helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

function writeTmpManifest(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  tmpDir = join(tmpdir(), `liteboard-parser-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("parseManifest", () => {
  // ── 1. Parse all task fields ────────────────────────────────────────────

  describe("parses all task fields from a sample manifest", () => {
    let tasks: Task[];

    beforeAll(() => {
      const manifestPath = writeTmpManifest("full.md", SAMPLE_MANIFEST);
      tasks = parseManifest(manifestPath);
    });

    it("returns the correct number of tasks", () => {
      expect(tasks).toHaveLength(3);
    });

    it("parses id from header", () => {
      expect(tasks[0].id).toBe(1);
      expect(tasks[1].id).toBe(2);
      expect(tasks[2].id).toBe(3);
    });

    it("parses title from header", () => {
      expect(tasks[0].title).toBe("Set up project scaffolding");
      expect(tasks[1].title).toBe("Implement database layer");
      expect(tasks[2].title).toBe("Add API routes");
    });

    it("parses creates as file list (backticks stripped)", () => {
      expect(tasks[0].creates).toEqual(["src/index.ts", "src/config.ts"]);
      expect(tasks[1].creates).toEqual(["src/db.ts"]);
      expect(tasks[2].creates).toEqual(["src/routes.ts", "src/middleware.ts"]);
    });

    it("parses modifies as file list (backticks stripped)", () => {
      expect(tasks[0].modifies).toEqual([]);
      expect(tasks[1].modifies).toEqual(["src/config.ts", "src/index.ts"]);
      expect(tasks[2].modifies).toEqual(["src/index.ts"]);
    });

    it("parses dependsOn as number array", () => {
      expect(tasks[0].dependsOn).toEqual([]);
      expect(tasks[1].dependsOn).toEqual([1]);
      expect(tasks[2].dependsOn).toEqual([1, 2]);
    });

    it("parses requirements as bullet list including sub-bullets", () => {
      expect(tasks[0].requirements).toEqual([
        "Initialize the project structure",
        "Create entry point with CLI argument parsing",
        "Support `--verbose` flag",
        "Support `--config` flag",
        "Add config loader module",
      ]);
      expect(tasks[1].requirements).toEqual([
        "Create database connection module",
        "Add migration runner",
        "Wire into config and entry point",
      ]);
    });

    it("parses tddPhase", () => {
      expect(tasks[0].tddPhase).toBe("GREEN");
      expect(tasks[1].tddPhase).toBe("RED");
    });

    it("normalizes tddPhase case-insensitively", () => {
      const manifest = `
### Task 1: Lowercase TDD

**TDD Phase:** green
**Complexity Score:** 1

### Task 2: Mixed case

**TDD Phase:** exempt
**Complexity Score:** 1
`.trimStart();
      const manifestPath = writeTmpManifest("tdd-case.md", manifest);
      const result = parseManifest(manifestPath);
      expect(result[0].tddPhase).toBe("GREEN");
      expect(result[1].tddPhase).toBe("Exempt");
    });

    it("parses commitMessage", () => {
      expect(tasks[0].commitMessage).toBe(
        "feat: scaffold project with CLI entry and config loader",
      );
      expect(tasks[1].commitMessage).toBe(
        "feat: add database layer with migrations",
      );
    });

    it("parses complexity score as number", () => {
      expect(tasks[0].complexity).toBe(3);
      expect(tasks[1].complexity).toBe(5);
      expect(tasks[2].complexity).toBe(8);
    });
  });

  // ── 2. Header splitting ────────────────────────────────────────────────

  describe("splits sections by ### Task N: <title> headers", () => {
    it("ignores content before the first task header", () => {
      const manifestPath = writeTmpManifest("headers.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      // The overview section should not create a task
      expect(tasks.every((t) => t.id > 0)).toBe(true);
    });

    it("handles consecutive task headers without extra content", () => {
      const minimal = `
### Task 1: First

**Complexity Score:** 1

### Task 2: Second

**Complexity Score:** 2
`.trimStart();
      const manifestPath = writeTmpManifest("consecutive.md", minimal);
      const tasks = parseManifest(manifestPath);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].title).toBe("First");
      expect(tasks[1].title).toBe("Second");
    });
  });

  // ── 3. Creates / Modifies as comma-separated file lists ────────────────

  describe("parses Creates and Modifies as comma-separated file lists", () => {
    it("strips backticks from file paths", () => {
      const manifestPath = writeTmpManifest("backticks.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      for (const task of tasks) {
        for (const f of [...task.creates, ...task.modifies]) {
          expect(f).not.toContain("`");
        }
      }
    });

    it("handles single file in creates", () => {
      const manifestPath = writeTmpManifest("single.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[1].creates).toEqual(["src/db.ts"]);
    });
  });

  // ── 4. Depends on → number array ──────────────────────────────────────

  describe("parses Depends on as Task N references → number array", () => {
    it("returns empty array for (none)", () => {
      const manifestPath = writeTmpManifest("deps-none.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].dependsOn).toEqual([]);
    });

    it("parses single dependency", () => {
      const manifestPath = writeTmpManifest("deps-single.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[1].dependsOn).toEqual([1]);
    });

    it("parses multiple dependencies", () => {
      const manifestPath = writeTmpManifest("deps-multi.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[2].dependsOn).toEqual([1, 2]);
    });
  });

  // ── 5. Requirements as bullet list ────────────────────────────────────

  describe("parses Requirements as bullet list with sub-bullets", () => {
    it("collects all top-level and nested bullets", () => {
      const manifestPath = writeTmpManifest("reqs.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].requirements).toHaveLength(5);
    });

    it("preserves sub-bullet text without leading whitespace or dash", () => {
      const manifestPath = writeTmpManifest("reqs2.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].requirements).toContain("Support `--verbose` flag");
      expect(tasks[0].requirements).toContain("Support `--config` flag");
    });
  });

  // ── Backtick stripping from single-value fields ────────────────────────

  describe("strips backticks from single-value fields", () => {
    it("strips backticks from commit message", () => {
      const manifest = `
### Task 1: Test backticks

**Commit:** \`feat: add new feature\`
**Complexity Score:** 3
`.trimStart();
      const manifestPath = writeTmpManifest("backticks-commit.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].commitMessage).toBe("feat: add new feature");
    });

    it("strips backticks from TDD phase", () => {
      const manifest = `
### Task 1: Test backticks

**TDD Phase:** \`RED → GREEN\`
`.trimStart();
      const manifestPath = writeTmpManifest("backticks-tdd.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].tddPhase).toBe("RED → GREEN");
    });

    it("normalizes ASCII arrows to unicode in TDD phase", () => {
      const manifest = `
### Task 1: ASCII arrows

**TDD Phase:** RED -> GREEN -> REFACTOR
`.trimStart();
      const manifestPath = writeTmpManifest("ascii-arrows-tdd.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].tddPhase).toBe("RED \u2192 GREEN \u2192 REFACTOR");
    });

    it("parses RED -> GREEN -> REFACTOR as valid TDD phase", () => {
      const manifest = `
### Task 1: Full TDD

**TDD Phase:** RED \u2192 GREEN \u2192 REFACTOR
`.trimStart();
      const manifestPath = writeTmpManifest("full-tdd.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].tddPhase).toBe("RED \u2192 GREEN \u2192 REFACTOR");
    });
  });

  // ── 6. Single-value fields ────────────────────────────────────────────

  describe("parses single-value fields", () => {
    it("parses TDD Phase as string", () => {
      const manifestPath = writeTmpManifest("sv1.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(typeof tasks[0].tddPhase).toBe("string");
      expect(tasks[0].tddPhase).toBe("GREEN");
    });

    it("parses Commit as string", () => {
      const manifestPath = writeTmpManifest("sv2.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(typeof tasks[0].commitMessage).toBe("string");
    });

    it("parses Complexity Score as number", () => {
      const manifestPath = writeTmpManifest("sv3.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(typeof tasks[0].complexity).toBe("number");
      expect(tasks[0].complexity).toBe(3);
    });
  });

  // ── 7. Initial status assignment ──────────────────────────────────────

  describe("sets initial statuses based on dependencies", () => {
    it("sets status to 'queued' for tasks with no dependencies", () => {
      const manifestPath = writeTmpManifest("status1.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].status).toBe("queued");
    });

    it("sets status to 'blocked' for tasks with dependencies", () => {
      const manifestPath = writeTmpManifest("status2.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[1].status).toBe("blocked");
      expect(tasks[2].status).toBe("blocked");
    });
  });

  // ── 8. Malformed manifest handling ────────────────────────────────────

  describe("handles malformed manifest gracefully", () => {
    let tasks: Task[];

    beforeAll(() => {
      const manifestPath = writeTmpManifest(
        "malformed.md",
        MALFORMED_MANIFEST,
      );
      tasks = parseManifest(manifestPath);
    });

    it("still parses tasks from malformed manifest", () => {
      expect(tasks).toHaveLength(2);
    });

    it("defaults creates to empty array when missing", () => {
      expect(tasks[0].creates).toEqual([]);
    });

    it("defaults modifies to empty array when missing", () => {
      expect(tasks[0].modifies).toEqual([]);
    });

    it("defaults dependsOn to empty array when missing", () => {
      expect(tasks[0].dependsOn).toEqual([]);
    });

    it("defaults tddPhase to empty string when missing", () => {
      expect(tasks[0].tddPhase).toBe("");
    });

    it("defaults commitMessage to empty string when missing", () => {
      expect(tasks[0].commitMessage).toBe("");
    });

    it("defaults complexity to 0 when missing", () => {
      expect(tasks[0].complexity).toBe(0);
    });

    it("still parses fields that are present", () => {
      expect(tasks[0].requirements).toEqual(["Just one thing"]);
      expect(tasks[1].creates).toEqual(["src/foo.ts"]);
      expect(tasks[1].dependsOn).toEqual([1]);
    });
  });

  // ── 9. (none) handling ────────────────────────────────────────────────

  describe("handles (none) for creates and modifies", () => {
    it("returns empty array for creates when (none)", () => {
      const manifest = `
### Task 1: Test

**Creates:** (none)
**Modifies:** (none)
`.trimStart();
      const manifestPath = writeTmpManifest("none.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].creates).toEqual([]);
      expect(tasks[0].modifies).toEqual([]);
    });
  });

  // ── Type field parsing ────────────────────────────────────────────────

  describe("parses Type field", () => {
    it("parses Type: QA as type: 'qa'", () => {
      const manifest = `
### Task 1: Validate all

**Type:** QA
**Depends on:** (none)
**Complexity Score:** 2
`.trimStart();
      const manifestPath = writeTmpManifest("type-qa.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].type).toBe("qa");
    });

    it("parses Type: qa (lowercase) as type: 'qa'", () => {
      const manifest = `
### Task 1: Validate all

**Type:** qa
**Complexity Score:** 2
`.trimStart();
      const manifestPath = writeTmpManifest("type-qa-lower.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].type).toBe("qa");
    });

    it("returns type: undefined when Type field is missing", () => {
      const manifest = `
### Task 1: Normal task

**Complexity Score:** 2
`.trimStart();
      const manifestPath = writeTmpManifest("type-missing.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].type).toBeUndefined();
    });

    it("returns type: undefined for Type: implementation", () => {
      const manifest = `
### Task 1: Impl task

**Type:** implementation
**Complexity Score:** 2
`.trimStart();
      const manifestPath = writeTmpManifest("type-impl.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].type).toBeUndefined();
    });
  });

  // ── Runtime defaults ──────────────────────────────────────────────────

  describe("sets runtime defaults for non-manifest fields", () => {
    it("sets turnCount to 0", () => {
      const manifestPath = writeTmpManifest("defaults.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].turnCount).toBe(0);
    });

    it("sets lastLine to empty string", () => {
      const manifestPath = writeTmpManifest("defaults2.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].lastLine).toBe("");
    });

    it("sets bytesReceived to 0", () => {
      const manifestPath = writeTmpManifest("defaults3.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].bytesReceived).toBe(0);
    });

    it("sets stage to empty string", () => {
      const manifestPath = writeTmpManifest("defaults4.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].stage).toBe("");
    });
  });

  // ── 10. Manifest validation ─────────────────────────────────────────────

  describe("validates manifest", () => {
    it("throws on duplicate task IDs", () => {
      const manifest = `
### Task 1: First

**Complexity Score:** 1

### Task 1: Duplicate

**Complexity Score:** 2
`.trimStart();
      const manifestPath = writeTmpManifest("dup-ids.md", manifest);
      expect(() => parseManifest(manifestPath)).toThrow(/Duplicate task ID: 1/);
    });

    it("throws on dangling dependency references", () => {
      const manifest = `
### Task 1: First

**Depends on:** Task 99
**Complexity Score:** 1
`.trimStart();
      const manifestPath = writeTmpManifest("dangling-dep.md", manifest);
      expect(() => parseManifest(manifestPath)).toThrow(
        /Task 1 depends on Task 99, which does not exist/,
      );
    });

    it("passes validation for a well-formed manifest", () => {
      const manifestPath = writeTmpManifest("valid.md", SAMPLE_MANIFEST);
      expect(() => parseManifest(manifestPath)).not.toThrow();
    });

    it("warns to stderr for unrecognized Type but does not throw", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const manifest = `
### Task 1: Custom type

**Type:** weird
**Complexity Score:** 1
`.trimStart();
      const manifestPath = writeTmpManifest("type-warn.md", manifest);
      expect(() => parseManifest(manifestPath)).not.toThrow();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('unrecognized Type "weird"'),
      );
      spy.mockRestore();
    });

    it("warns to stderr for out-of-range complexity but does not throw", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const manifest = `
### Task 1: Over-complex

**Complexity Score:** 15
`.trimStart();
      const manifestPath = writeTmpManifest("complexity-warn.md", manifest);
      expect(() => parseManifest(manifestPath)).not.toThrow();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("Task 1 has complexity 15"),
      );
      spy.mockRestore();
    });
  });

  // ── 11. Explore field parsing ──────────────────────────────────────────

  describe("parses Explore as bullet list", () => {
    it("parses explore targets from manifest", () => {
      const manifestPath = writeTmpManifest("explore.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[1].explore).toEqual([
        "How the config loader discovers files — for wiring database config",
        "What CLI argument patterns exist — for adding new flags",
      ]);
    });

    it("returns empty array when Explore field is missing", () => {
      const manifestPath = writeTmpManifest("explore-missing.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      // Task 1 has no Explore field
      expect(tasks[0].explore).toEqual([]);
    });

    it("returns empty array when Explore field is (none)", () => {
      const manifest = `
### Task 1: No explore

**Explore:** (none)
**Complexity Score:** 1
`.trimStart();
      const manifestPath = writeTmpManifest("explore-none.md", manifest);
      const tasks = parseManifest(manifestPath);
      // parseBulletList finds no bullets after "(none)" on the header line
      expect(tasks[0].explore).toEqual([]);
    });
  });

  // ── 12. suggestedSession field parsing ───────────────────────────────────

  describe("parses Suggested Session field", () => {
    it("parses Suggested Session as string when present", () => {
      const manifest = `
### Task 1: Types update

**Complexity Score:** 3
**Suggested Session:** S1

### Task 2: Parser update

**Depends on:** Task 1
**Complexity Score:** 5
**Suggested Session:** S2
`.trimStart();
      const manifestPath = writeTmpManifest("suggested-session.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].suggestedSession).toBe("S1");
      expect(tasks[1].suggestedSession).toBe("S2");
    });

    it("leaves suggestedSession undefined when field is absent", () => {
      const manifestPath = writeTmpManifest("no-session.md", SAMPLE_MANIFEST);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].suggestedSession).toBeUndefined();
      expect(tasks[1].suggestedSession).toBeUndefined();
    });

    it("multiple tasks can share the same suggestedSession", () => {
      const manifest = `
### Task 1: First

**Complexity Score:** 3
**Suggested Session:** S1

### Task 2: Second

**Complexity Score:** 5
**Suggested Session:** S1
`.trimStart();
      const manifestPath = writeTmpManifest("shared-session.md", manifest);
      const tasks = parseManifest(manifestPath);
      expect(tasks[0].suggestedSession).toBe("S1");
      expect(tasks[1].suggestedSession).toBe("S1");
    });
  });
});

// ─── parseSessions Tests ──────────────────────────────────────────────────────

// Helper to create a minimal Task object
function makeTask(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    explore: [],
    tddPhase: "",
    commitMessage: "",
    complexity: 3,
    status: "queued",
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
    ...overrides,
  };
}

const MANIFEST_WITH_HINTS = `
# Task Manifest

## Session-Grouping Hints

| Session | Tasks | Layer | Total Complexity | Focus |
|---------|-------|-------|-----------------|-------|
| S1 | T1, T5 | 0 | 8 | Types/config + brief improvements |
| S2 | T2, T3 | 0 | 6 | Git cleanup + spawner resilience |

### Task 1: Types update

**Complexity Score:** 3
**Suggested Session:** S1

### Task 2: Git cleanup

**Complexity Score:** 3
**Suggested Session:** S2

### Task 3: Spawner resilience

**Depends on:** Task 2
**Complexity Score:** 3
**Suggested Session:** S2
`.trimStart();

describe("parseSessions", () => {
  // ── Groups tasks by suggestedSession ─────────────────────────────────────

  describe("groups tasks by suggestedSession hint", () => {
    it("creates one session per unique suggestedSession value", () => {
      const tasks = [
        makeTask({ id: 1, title: "Types update", complexity: 3, suggestedSession: "S1" }),
        makeTask({ id: 2, title: "Git cleanup", complexity: 3, suggestedSession: "S2" }),
        makeTask({ id: 3, title: "Spawner resilience", complexity: 3, suggestedSession: "S2", dependsOn: [2], status: "blocked" }),
      ];
      const sessions = parseSessions(tasks, "");
      expect(sessions).toHaveLength(2);
    });

    it("assigns all tasks with the same session hint to the same session", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", complexity: 3, suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", complexity: 4, suggestedSession: "S1" }),
      ];
      const sessions = parseSessions(tasks, "");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].tasks.map((t) => t.id)).toEqual([1, 2]);
    });

    it("computes complexity as sum of task complexities", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", complexity: 3, suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", complexity: 5, suggestedSession: "S1" }),
      ];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].complexity).toBe(8);
    });

    it("session id matches the suggestedSession value", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", complexity: 2, suggestedSession: "S3" }),
      ];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].id).toBe("S3");
    });
  });

  // ── Auto-generates sessions for tasks without hints ───────────────────────

  describe("auto-generates sessions for tasks without suggestedSession", () => {
    it("creates a single-task session for each unsorted task", () => {
      const tasks = [
        makeTask({ id: 1, title: "Standalone task" }),
        makeTask({ id: 2, title: "Another standalone" }),
      ];
      const sessions = parseSessions(tasks, "");
      expect(sessions).toHaveLength(2);
    });

    it("auto-session id is S-auto-T<taskId>", () => {
      const tasks = [makeTask({ id: 5, title: "Orphan task" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].id).toBe("S-auto-T5");
    });

    it("auto-session contains exactly the one task", () => {
      const tasks = [makeTask({ id: 3, title: "Solo" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].tasks).toHaveLength(1);
      expect(sessions[0].tasks[0].id).toBe(3);
    });
  });

  // ── Mixed: some with hints, some without ────────────────────────────────

  describe("handles mixed tasks (some with hints, some without)", () => {
    it("returns correct session count for mixed input", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", suggestedSession: "S1" }),
        makeTask({ id: 3, title: "T3" }), // no hint
      ];
      const sessions = parseSessions(tasks, "");
      // S1 (2 tasks) + auto-T3 (1 task)
      expect(sessions).toHaveLength(2);
    });

    it("auto-session id does not conflict with named sessions", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2" }),
      ];
      const sessions = parseSessions(tasks, "");
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("S1");
      expect(ids).toContain("S-auto-T2");
    });
  });

  // ── Focus derivation from hints table ────────────────────────────────────

  describe("derives focus from session-grouping hints table", () => {
    it("uses focus column from hints table when available", () => {
      const tasks = [
        makeTask({ id: 1, title: "Types update", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "Git cleanup", suggestedSession: "S2" }),
        makeTask({ id: 3, title: "Spawner resilience", dependsOn: [2], status: "blocked", suggestedSession: "S2" }),
      ];
      const sessions = parseSessions(tasks, MANIFEST_WITH_HINTS);
      const s1 = sessions.find((s) => s.id === "S1")!;
      const s2 = sessions.find((s) => s.id === "S2")!;
      expect(s1.focus).toBe("Types/config + brief improvements");
      expect(s2.focus).toBe("Git cleanup + spawner resilience");
    });

    it("falls back to joined task titles when session not in hints table", () => {
      const tasks = [
        makeTask({ id: 1, title: "My Feature", suggestedSession: "S99" }),
      ];
      const sessions = parseSessions(tasks, MANIFEST_WITH_HINTS);
      const s = sessions.find((s) => s.id === "S99")!;
      expect(s.focus).toBe("My Feature");
    });

    it("joins multiple task titles with ', ' when no hints entry found", () => {
      const tasks = [
        makeTask({ id: 1, title: "Feature A", suggestedSession: "S99" }),
        makeTask({ id: 2, title: "Feature B", suggestedSession: "S99" }),
      ];
      const sessions = parseSessions(tasks, MANIFEST_WITH_HINTS);
      const s = sessions[0];
      expect(s.focus).toBe("Feature A, Feature B");
    });

    it("derives focus from task title for auto-sessions", () => {
      const tasks = [makeTask({ id: 7, title: "Lonely task" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].focus).toBe("Lonely task");
    });
  });

  // ── Focus derivation without hints table ────────────────────────────────

  describe("derives focus from task titles when no hints table present", () => {
    it("uses single task title as focus", () => {
      const tasks = [makeTask({ id: 1, title: "Do something", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "no table here");
      expect(sessions[0].focus).toBe("Do something");
    });

    it("joins multiple task titles as focus", () => {
      const tasks = [
        makeTask({ id: 1, title: "Task Alpha", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "Task Beta", suggestedSession: "S1" }),
      ];
      const sessions = parseSessions(tasks, "no table here");
      expect(sessions[0].focus).toBe("Task Alpha, Task Beta");
    });
  });

  // ── Runtime field initialization ─────────────────────────────────────────

  describe("initializes all runtime fields to defaults", () => {
    it("status is 'queued' when all tasks are queued", () => {
      const tasks = [makeTask({ id: 1, title: "T1", status: "queued", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].status).toBe("queued");
    });

    it("status is 'blocked' when any task in the session is blocked", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", status: "queued", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", status: "blocked", dependsOn: [1], suggestedSession: "S1" }),
      ];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].status).toBe("blocked");
    });

    it("sets bytesReceived to 0", () => {
      const tasks = [makeTask({ id: 1, title: "T1", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].bytesReceived).toBe(0);
    });

    it("sets turnCount to 0", () => {
      const tasks = [makeTask({ id: 1, title: "T1", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].turnCount).toBe(0);
    });

    it("sets lastLine to empty string", () => {
      const tasks = [makeTask({ id: 1, title: "T1", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].lastLine).toBe("");
    });

    it("sets stage to empty string", () => {
      const tasks = [makeTask({ id: 1, title: "T1", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].stage).toBe("");
    });

    it("sets attemptCount to 0", () => {
      const tasks = [makeTask({ id: 1, title: "T1", suggestedSession: "S1" })];
      const sessions = parseSessions(tasks, "");
      expect(sessions[0].attemptCount).toBe(0);
    });
  });

  // ── Layer consistency validation ─────────────────────────────────────────

  describe("validates layer consistency when taskLayerMap provided", () => {
    it("does not throw when all tasks in a session share the same layer", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", suggestedSession: "S1" }),
      ];
      const layerMap = new Map([[1, 0], [2, 0]]);
      expect(() => parseSessions(tasks, "", layerMap)).not.toThrow();
    });

    it("throws when tasks in a session span multiple layers", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", suggestedSession: "S1" }),
      ];
      const layerMap = new Map([[1, 0], [2, 1]]);
      expect(() => parseSessions(tasks, "", layerMap)).toThrow(/cross-layer/i);
    });

    it("does not validate layers when taskLayerMap is not provided", () => {
      const tasks = [
        makeTask({ id: 1, title: "T1", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", suggestedSession: "S1" }),
      ];
      expect(() => parseSessions(tasks, "")).not.toThrow();
    });
  });

  // ── Stable sort order ────────────────────────────────────────────────────

  describe("returns sessions in stable order by first task id", () => {
    it("orders sessions by the smallest task id in each session", () => {
      const tasks = [
        makeTask({ id: 3, title: "T3", suggestedSession: "S2" }),
        makeTask({ id: 1, title: "T1", suggestedSession: "S1" }),
        makeTask({ id: 2, title: "T2", suggestedSession: "S1" }),
      ];
      const sessions = parseSessions(tasks, "");
      // S1 has task 1 (min id = 1), S2 has task 3 (min id = 3)
      expect(sessions[0].id).toBe("S1");
      expect(sessions[1].id).toBe("S2");
    });

    it("returns empty array for empty task list", () => {
      const sessions = parseSessions([], "");
      expect(sessions).toEqual([]);
    });
  });
});
