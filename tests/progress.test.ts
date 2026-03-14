import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, Session, TaskStatus, SessionStatus } from "../src/types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => {
  return {
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

vi.mock("node:child_process", () => {
  return {
    execFileSync: vi.fn(),
  };
});

import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  writeProgress,
  readProgress,
  detectCompletedFromGitLog,
} from "../src/progress.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    explore: [],
    tddPhase: "GREEN",
    commitMessage: `implement task ${overrides.id}`,
    complexity: 1,
    status: "queued" as TaskStatus,
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    tasks: [],
    complexity: 1,
    focus: "Test session",
    status: "queued" as SessionStatus,
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
    ...overrides,
  };
}

// ─── writeProgress ───────────────────────────────────────────────────────────

describe("writeProgress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes session table followed by task table", () => {
    const sessions: Session[] = [
      makeSession({ id: "S1", focus: "Foundation", status: "done", completedAt: "2026-03-13T10:00:00Z" }),
      makeSession({ id: "S2", focus: "Core logic", status: "running" }),
    ];
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Setup project", status: "done", completedAt: "2026-03-10T12:00:00Z" }),
      makeTask({ id: 2, title: "Add tests", status: "running" }),
    ];

    writeProgress(sessions, tasks, "/fake/project");

    expect(writeFileSync).toHaveBeenCalledOnce();
    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;

    // Session table present
    expect(text).toContain("## Sessions");
    expect(text).toContain("| Session | Focus | Status | Completed At |");
    expect(text).toContain("| S1 | Foundation | done | 2026-03-13T10:00:00Z |");
    expect(text).toContain("| S2 | Core logic | running |");

    // Task table present
    expect(text).toContain("## Tasks");
    expect(text).toContain("| Task | Title | Status | Completed At | Failure Summary |");
    expect(text).toContain("| 1 | Setup project | done | 2026-03-10T12:00:00Z |");
    expect(text).toContain("| 2 | Add tests | running |");

    // Sessions section appears before Tasks section
    expect(text.indexOf("## Sessions")).toBeLessThan(text.indexOf("## Tasks"));
  });

  it("writes a markdown table with task statuses", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Setup project", status: "done", completedAt: "2026-03-10T12:00:00Z" }),
      makeTask({ id: 2, title: "Add tests", status: "running" }),
      makeTask({ id: 3, title: "Implement feature", status: "queued" }),
    ];

    writeProgress([], tasks, "/fake/project");

    expect(writeFileSync).toHaveBeenCalledOnce();
    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;

    // Task table present
    expect(text).toContain("| Task | Title | Status | Completed At | Failure Summary |");
    expect(text).toContain("| --- | --- | --- | --- | --- |");
    expect(text).toContain("| 1 | Setup project | done | 2026-03-10T12:00:00Z |");
    expect(text).toContain("| 2 | Add tests | running |");
    expect(text).toContain("| 3 | Implement feature | queued |");
  });

  it("uses atomic write (temp file + rename)", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Task one", status: "done" }),
    ];

    writeProgress([], tasks, "/fake/project");

    expect(writeFileSync).toHaveBeenCalledOnce();
    const [tempPath] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tempPath).toContain("progress.md.tmp");

    expect(renameSync).toHaveBeenCalledOnce();
    const [from, to] = (renameSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(from).toBe(tempPath);
    expect(to).toContain("progress.md");
    expect(to).not.toContain(".tmp");
  });

  it("includes failure summary for failed tasks", () => {
    const tasks: Task[] = [
      makeTask({
        id: 1,
        title: "Broken task",
        status: "failed",
        lastLine: "Error: something went wrong",
      }),
    ];

    writeProgress([], tasks, "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("Error: something went wrong");
  });

  it("includes failure summary for needs_human tasks", () => {
    const tasks: Task[] = [
      makeTask({
        id: 1,
        title: "Stuck task",
        status: "needs_human",
        lastLine: "Triage escalated: cannot resolve merge conflict",
      }),
    ];

    writeProgress([], tasks, "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("| needs_human |");
    expect(text).toContain("Triage escalated: cannot resolve merge conflict");
  });

  it("writes merging status verbatim", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Merging task", status: "merging" }),
    ];

    writeProgress([], tasks, "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("| merging |");
  });

  it("writes session done status with completedAt", () => {
    const sessions: Session[] = [
      makeSession({ id: "S1", focus: "Foundation", status: "done", completedAt: "2026-03-13T10:00:00Z" }),
    ];

    writeProgress(sessions, [], "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("| S1 | Foundation | done | 2026-03-13T10:00:00Z |");
  });

  it("writes session needs_human status", () => {
    const sessions: Session[] = [
      makeSession({ id: "S2", focus: "Core logic", status: "needs_human" }),
    ];

    writeProgress(sessions, [], "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("| S2 | Core logic | needs_human |");
  });
});

// ─── writeProgress — pipe escaping ────────────────────────────────────────

describe("writeProgress — pipe character escaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("escapes pipe characters in title and failure summary", () => {
    const tasks: Task[] = [
      makeTask({
        id: 1,
        title: "Task with | pipe",
        status: "failed",
        lastLine: "Error: foo | bar | baz",
      }),
    ];

    writeProgress([], tasks, "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("Task with \\| pipe");
    expect(text).toContain("Error: foo \\| bar \\| baz");
  });

  it("escapes pipe characters in session focus", () => {
    const sessions: Session[] = [
      makeSession({ id: "S1", focus: "Auth | Config", status: "done", completedAt: "2026-03-13T10:00:00Z" }),
    ];

    writeProgress(sessions, [], "/fake/project");

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = content as string;
    expect(text).toContain("Auth \\| Config");
  });
});

// ─── readProgress — pipe roundtrip ──────────────────────────────────────

describe("readProgress — pipe character roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves pipe characters through write→read roundtrip (new format)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Task with \\| pipe | done | 2026-03-10T12:00:00Z | |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks.size).toBe(1);
    expect(result.tasks.get(1)).toEqual({ status: "done", completedAt: "2026-03-10T12:00:00Z" });
  });
});

// ─── readProgress ────────────────────────────────────────────────────────────

describe("readProgress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns map of completed task IDs to timestamps (new format)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "| S1 | Foundation | done | 2026-03-13T10:00:00Z |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Setup project | done | 2026-03-10T12:00:00Z | |",
        "| 2 | Add tests | done | 2026-03-10T13:00:00Z | |",
        "| 3 | Implement feature | running | | |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks).toBeInstanceOf(Map);
    expect(result.tasks.size).toBe(2);
    expect(result.tasks.get(1)).toEqual({ status: "done", completedAt: "2026-03-10T12:00:00Z" });
    expect(result.tasks.get(2)).toEqual({ status: "done", completedAt: "2026-03-10T13:00:00Z" });
    expect(result.tasks.has(3)).toBe(false);

    expect(result.sessions).toBeInstanceOf(Map);
    expect(result.sessions.size).toBe(1);
    expect(result.sessions.get("S1")).toEqual({ status: "done", completedAt: "2026-03-13T10:00:00Z" });
  });

  it("returns empty maps for non-existent file", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = readProgress("/fake/project");

    expect(result.tasks).toBeInstanceOf(Map);
    expect(result.tasks.size).toBe(0);
    expect(result.sessions).toBeInstanceOf(Map);
    expect(result.sessions.size).toBe(0);
  });

  it("reads session done status correctly", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "| S1 | Foundation | done | 2026-03-13T10:00:00Z |",
        "| S2 | Core logic | done | 2026-03-13T11:00:00Z |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.sessions.size).toBe(2);
    expect(result.sessions.get("S1")).toEqual({ status: "done", completedAt: "2026-03-13T10:00:00Z" });
    expect(result.sessions.get("S2")).toEqual({ status: "done", completedAt: "2026-03-13T11:00:00Z" });
  });

  it("reads session needs_human status correctly", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "| S1 | Foundation | needs_human | |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.sessions.get("S1")).toEqual({ status: "needs_human" });
  });
});

// ─── readProgress — session merging re-queued ──────────────────────────────

describe("readProgress — session merging re-queued", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not include merging sessions in sessions map (re-queued on resume)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "| S1 | Foundation | merging | |",
        "| S2 | Core logic | done | 2026-03-13T11:00:00Z |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.sessions.has("S1")).toBe(false);  // merging → re-queued
    expect(result.sessions.has("S2")).toBe(true);   // done → preserved
    expect(result.sessions.get("S2")).toEqual({ status: "done", completedAt: "2026-03-13T11:00:00Z" });
  });

  it("does not include failed sessions in sessions map (re-queued on resume)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "| S1 | Foundation | failed | |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.sessions.has("S1")).toBe(false);
  });
});

// ─── readProgress — backward compat (old format) ────────────────────────────

describe("readProgress — backward compat with old format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses old format (no ## Sessions header) as tasks table", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Setup project | done | 2026-03-10T12:00:00Z | |",
        "| 2 | Add tests | done | 2026-03-10T13:00:00Z | |",
        "| 3 | Implement feature | running | | |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks).toBeInstanceOf(Map);
    expect(result.tasks.size).toBe(2);
    expect(result.tasks.get(1)).toEqual({ status: "done", completedAt: "2026-03-10T12:00:00Z" });
    expect(result.tasks.get(2)).toEqual({ status: "done", completedAt: "2026-03-10T13:00:00Z" });
    expect(result.tasks.has(3)).toBe(false);

    // Sessions map should be empty for old format
    expect(result.sessions).toBeInstanceOf(Map);
    expect(result.sessions.size).toBe(0);
  });

  it("does not include merging tasks in result map in old format (re-queued on resume)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Merging task | merging | | |",
        "| 2 | Done task | done | 2026-03-13T08:00:00Z | |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks.has(1)).toBe(false);  // merging → re-queued
    expect(result.tasks.has(2)).toBe(true);   // done → preserved
  });
});

// ─── readProgress — needs_human and merging resume behavior ─────────────────

describe("readProgress — needs_human and merging resume behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes needs_human tasks in result map (not re-queued on resume)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Done task | done | 2026-03-13T08:00:00Z | |",
        "| 2 | Stuck task | needs_human | | Escalated: merge conflict |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks.has(1)).toBe(true);
    expect(result.tasks.has(2)).toBe(true);
  });

  it("does not include merging tasks in result map (re-queued on resume)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Merging task | merging | | |",
        "| 2 | Done task | done | 2026-03-13T08:00:00Z | |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks.has(1)).toBe(false);  // merging → re-queued
    expect(result.tasks.has(2)).toBe(true);   // done → preserved
  });

  it("does not include failed tasks in result map (re-queued on resume)", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Failed task | failed | | Error happened |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks.has(1)).toBe(false);  // failed → re-queued
  });

  it("needs_human task uses 'needs_human' sentinel in the map", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      [
        "## Sessions",
        "| Session | Focus | Status | Completed At |",
        "| --- | --- | --- | --- |",
        "",
        "## Tasks",
        "| Task | Title | Status | Completed At | Failure Summary |",
        "| --- | --- | --- | --- | --- |",
        "| 5 | Escalated | needs_human | | Agent failed 3 times |",
      ].join("\n"),
    );

    const result = readProgress("/fake/project");

    expect(result.tasks.has(5)).toBe(true);
    expect(result.tasks.get(5)).toEqual({ status: "needs_human" });
  });
});

// ─── detectCompletedFromGitLog ───────────────────────────────────────────────

describe("detectCompletedFromGitLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches [task N] prefix in commit messages", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Setup project", commitMessage: "setup the project" }),
      makeTask({ id: 2, title: "Add tests", commitMessage: "add unit tests" }),
      makeTask({ id: 3, title: "Implement feature", commitMessage: "build feature X" }),
    ];

    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      Buffer.from(
        [
          "[task 1] setup the project",
          "[task 3] build feature X",
        ].join("\n"),
      ),
    );

    const result = detectCompletedFromGitLog("feature/branch", tasks, false);

    expect(result).toBeInstanceOf(Set);
    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(false);
    expect(result.has(3)).toBe(true);
  });

  it("matches exact commitMessage strings", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Setup project", commitMessage: "setup the project" }),
      makeTask({ id: 2, title: "Add tests", commitMessage: "add unit tests" }),
    ];

    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      Buffer.from(
        [
          "add unit tests",
          "some other commit",
        ].join("\n"),
      ),
    );

    const result = detectCompletedFromGitLog("feature/branch", tasks, false);

    expect(result).toBeInstanceOf(Set);
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(true);
  });

  it("returns empty set when branch doesn't exist", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: "Setup project", commitMessage: "setup the project" }),
    ];

    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("fatal: bad default revision 'nonexistent-branch'");
    });

    const result = detectCompletedFromGitLog("nonexistent-branch", tasks, false);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });
});
