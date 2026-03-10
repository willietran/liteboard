import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseManifest } from "../src/parser.js";
import type { Task } from "../src/types.js";

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
  });
});
