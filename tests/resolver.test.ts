import { describe, it, expect } from "vitest";
import { topologicalSort, hasFileConflict, resolveSessionDependencies, getReadySessions, hasSessionFileConflict } from "../src/resolver.js";
import type { Task, Session } from "../src/types.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeTask(partial: Partial<Task> & { id: number }): Task {
  return {
    title: `Task ${partial.id}`,
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    tddPhase: "GREEN",
    commitMessage: "",
    complexity: 1,
    status: "blocked",
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
    ...partial,
  };
}

// ─── topologicalSort ─────────────────────────────────────────────────────────

describe("topologicalSort", () => {
  it("produces correct layers for a simple dependency graph", () => {
    // A(1) -> B(2) -> C(3)
    const tasks: Task[] = [
      makeTask({ id: 1, dependsOn: [] }),
      makeTask({ id: 2, dependsOn: [1] }),
      makeTask({ id: 3, dependsOn: [2] }),
    ];

    const layers = topologicalSort(tasks);

    expect(layers).toHaveLength(3);
    expect(layers[0]).toEqual({ layerIndex: 0, taskIds: [1] });
    expect(layers[1]).toEqual({ layerIndex: 1, taskIds: [2] });
    expect(layers[2]).toEqual({ layerIndex: 2, taskIds: [3] });
  });

  it("places tasks with no dependencies in Layer 0", () => {
    const tasks: Task[] = [
      makeTask({ id: 1 }),
      makeTask({ id: 2 }),
      makeTask({ id: 3 }),
    ];

    const layers = topologicalSort(tasks);

    expect(layers).toHaveLength(1);
    expect(layers[0].layerIndex).toBe(0);
    expect(layers[0].taskIds).toEqual([1, 2, 3]);
  });

  it("places tasks depending on Layer 0 tasks into Layer 1, etc.", () => {
    //  1 ─┐
    //     ├─> 3 ─> 4
    //  2 ─┘
    const tasks: Task[] = [
      makeTask({ id: 1 }),
      makeTask({ id: 2 }),
      makeTask({ id: 3, dependsOn: [1, 2] }),
      makeTask({ id: 4, dependsOn: [3] }),
    ];

    const layers = topologicalSort(tasks);

    expect(layers).toHaveLength(3);
    expect(layers[0]).toEqual({ layerIndex: 0, taskIds: [1, 2] });
    expect(layers[1]).toEqual({ layerIndex: 1, taskIds: [3] });
    expect(layers[2]).toEqual({ layerIndex: 2, taskIds: [4] });
  });

  it("detects circular dependencies and throws a descriptive error", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, dependsOn: [3] }),
      makeTask({ id: 2, dependsOn: [1] }),
      makeTask({ id: 3, dependsOn: [2] }),
    ];

    expect(() => topologicalSort(tasks)).toThrowError(/circular dependency/i);
  });

  it("splits conflicting tasks in the same layer so lower ID runs first", () => {
    // Tasks 1 and 2 have no deps (same layer) but both create "README.md"
    const tasks: Task[] = [
      makeTask({ id: 1, creates: ["README.md"] }),
      makeTask({ id: 2, creates: ["README.md"] }),
      makeTask({ id: 3, dependsOn: [1, 2] }),
    ];

    const layers = topologicalSort(tasks);

    // Task 1 and 2 must NOT be in the same layer because they conflict.
    // Lower ID (1) should come first.
    const idsBeforeTask3 = layers
      .filter((l) => l.layerIndex < layers.find((l2) => l2.taskIds.includes(3))!.layerIndex)
      .flatMap((l) => l.taskIds);

    expect(idsBeforeTask3).toContain(1);
    expect(idsBeforeTask3).toContain(2);

    // Find the layers containing 1 and 2
    const layerOf1 = layers.find((l) => l.taskIds.includes(1))!;
    const layerOf2 = layers.find((l) => l.taskIds.includes(2))!;
    expect(layerOf1.layerIndex).toBeLessThan(layerOf2.layerIndex);
  });

  it("keeps non-conflicting tasks in the same layer", () => {
    const tasks: Task[] = [
      makeTask({ id: 1, creates: ["a.ts"] }),
      makeTask({ id: 2, creates: ["b.ts"] }),
    ];

    const layers = topologicalSort(tasks);

    expect(layers).toHaveLength(1);
    expect(layers[0].taskIds).toEqual([1, 2]);
  });

  it("handles an empty task list", () => {
    const layers = topologicalSort([]);
    expect(layers).toEqual([]);
  });
});

// ─── hasFileConflict ─────────────────────────────────────────────────────────

describe("hasFileConflict", () => {
  it("returns true when both tasks create the same file", () => {
    const a = makeTask({ id: 1, creates: ["src/index.ts"] });
    const b = makeTask({ id: 2, creates: ["src/index.ts"] });
    expect(hasFileConflict(a, b)).toBe(true);
  });

  it("returns true when both tasks modify the same file", () => {
    const a = makeTask({ id: 1, modifies: ["package.json"] });
    const b = makeTask({ id: 2, modifies: ["package.json"] });
    expect(hasFileConflict(a, b)).toBe(true);
  });

  it("returns true when one creates and the other modifies the same file", () => {
    const a = makeTask({ id: 1, creates: ["lib/utils.ts"] });
    const b = makeTask({ id: 2, modifies: ["lib/utils.ts"] });
    expect(hasFileConflict(a, b)).toBe(true);
  });

  it("returns true when modifies of one overlaps creates of the other (reversed)", () => {
    const a = makeTask({ id: 1, modifies: ["lib/utils.ts"] });
    const b = makeTask({ id: 2, creates: ["lib/utils.ts"] });
    expect(hasFileConflict(a, b)).toBe(true);
  });

  it("returns false when there is no file overlap", () => {
    const a = makeTask({ id: 1, creates: ["a.ts"], modifies: ["b.ts"] });
    const b = makeTask({ id: 2, creates: ["c.ts"], modifies: ["d.ts"] });
    expect(hasFileConflict(a, b)).toBe(false);
  });

  it("returns false when both tasks have empty creates and modifies", () => {
    const a = makeTask({ id: 1 });
    const b = makeTask({ id: 2 });
    expect(hasFileConflict(a, b)).toBe(false);
  });
});

// ─── Session helpers ──────────────────────────────────────────────────────────

function makeSession(partial: Partial<Session> & { id: string; tasks: Task[] }): Session {
  return {
    complexity: 1,
    focus: "",
    status: "queued",
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
    ...partial,
  };
}

// ─── resolveSessionDependencies ───────────────────────────────────────────────

describe("resolveSessionDependencies", () => {
  it("returns empty map for empty input", () => {
    const result = resolveSessionDependencies([]);
    expect(result.size).toBe(0);
  });

  it("returns entry with empty array for a session with no cross-session deps", () => {
    const tasks = [makeTask({ id: 1, dependsOn: [] }), makeTask({ id: 2, dependsOn: [1] })];
    const s1 = makeSession({ id: "S1", tasks });
    const result = resolveSessionDependencies([s1]);
    expect(result.get("S1")).toEqual([]);
  });

  it("lifts cross-session task dependencies to session dependencies", () => {
    const t1 = makeTask({ id: 1, dependsOn: [] });
    const t2 = makeTask({ id: 2, dependsOn: [1] }); // depends on t1 which is in S1
    const s1 = makeSession({ id: "S1", tasks: [t1] });
    const s2 = makeSession({ id: "S2", tasks: [t2] });
    const result = resolveSessionDependencies([s1, s2]);
    expect(result.get("S1")).toEqual([]);
    expect(result.get("S2")).toEqual(["S1"]);
  });

  it("ignores intra-session dependencies", () => {
    const t1 = makeTask({ id: 1, dependsOn: [] });
    const t2 = makeTask({ id: 2, dependsOn: [1] }); // both in same session
    const s1 = makeSession({ id: "S1", tasks: [t1, t2] });
    const result = resolveSessionDependencies([s1]);
    expect(result.get("S1")).toEqual([]);
  });

  it("deduplicates cross-session dependency session IDs", () => {
    const t1 = makeTask({ id: 1, dependsOn: [] });
    const t2 = makeTask({ id: 2, dependsOn: [] });
    // Both t3 and t4 depend on tasks in S1, should only list S1 once
    const t3 = makeTask({ id: 3, dependsOn: [1] });
    const t4 = makeTask({ id: 4, dependsOn: [2] });
    const s1 = makeSession({ id: "S1", tasks: [t1, t2] });
    const s2 = makeSession({ id: "S2", tasks: [t3, t4] });
    const result = resolveSessionDependencies([s1, s2]);
    expect(result.get("S2")).toEqual(["S1"]);
  });

  it("handles a chain of session dependencies", () => {
    const t1 = makeTask({ id: 1, dependsOn: [] });
    const t2 = makeTask({ id: 2, dependsOn: [1] });
    const t3 = makeTask({ id: 3, dependsOn: [2] });
    const s1 = makeSession({ id: "S1", tasks: [t1] });
    const s2 = makeSession({ id: "S2", tasks: [t2] });
    const s3 = makeSession({ id: "S3", tasks: [t3] });
    const result = resolveSessionDependencies([s1, s2, s3]);
    expect(result.get("S1")).toEqual([]);
    expect(result.get("S2")).toEqual(["S1"]);
    // S3 depends on t2 which lives in S2 (S2 depends on S1 separately)
    expect(result.get("S3")).toEqual(["S2"]);
  });
});

// ─── getReadySessions ─────────────────────────────────────────────────────────

describe("getReadySessions", () => {
  it("returns empty array for empty sessions", () => {
    const result = getReadySessions([], new Map());
    expect(result).toEqual([]);
  });

  it("returns queued session with no deps as ready", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "queued" });
    const deps = new Map([["S1", []]]);
    const result = getReadySessions([s1], deps);
    expect(result).toEqual([s1]);
  });

  it("returns queued session with all deps done as ready", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "done" });
    const s2 = makeSession({ id: "S2", tasks: [], status: "queued" });
    const deps = new Map([["S1", []], ["S2", ["S1"]]]);
    const result = getReadySessions([s1, s2], deps);
    expect(result).toEqual([s2]);
  });

  it("does not return a queued session blocked by a non-done dep", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "running" });
    const s2 = makeSession({ id: "S2", tasks: [], status: "queued" });
    const deps = new Map([["S1", []], ["S2", ["S1"]]]);
    const result = getReadySessions([s1, s2], deps);
    expect(result).toEqual([]);
  });

  it("does not return a queued session blocked by a failed dep", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "failed" });
    const s2 = makeSession({ id: "S2", tasks: [], status: "queued" });
    const deps = new Map([["S1", []], ["S2", ["S1"]]]);
    const result = getReadySessions([s1, s2], deps);
    expect(result).toEqual([]);
  });

  it("does not return non-queued sessions even if deps are done", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "done" });
    const s2 = makeSession({ id: "S2", tasks: [], status: "running" });
    const deps = new Map([["S1", []], ["S2", ["S1"]]]);
    const result = getReadySessions([s1, s2], deps);
    expect(result).toEqual([]);
  });

  it("treats session absent from deps map as having no deps (always ready if queued)", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "queued" });
    const result = getReadySessions([s1], new Map());
    expect(result).toEqual([s1]);
  });

  it("returns multiple ready sessions when all their deps are satisfied", () => {
    const s1 = makeSession({ id: "S1", tasks: [], status: "done" });
    const s2 = makeSession({ id: "S2", tasks: [], status: "queued" });
    const s3 = makeSession({ id: "S3", tasks: [], status: "queued" });
    const deps = new Map([["S1", []], ["S2", ["S1"]], ["S3", ["S1"]]]);
    const result = getReadySessions([s1, s2, s3], deps);
    expect(result).toHaveLength(2);
    expect(result).toContain(s2);
    expect(result).toContain(s3);
  });
});

// ─── hasSessionFileConflict ───────────────────────────────────────────────────

describe("hasSessionFileConflict", () => {
  it("returns false for sessions with no tasks", () => {
    const s1 = makeSession({ id: "S1", tasks: [] });
    const s2 = makeSession({ id: "S2", tasks: [] });
    expect(hasSessionFileConflict(s1, s2)).toBe(false);
  });

  it("returns false when sessions touch completely different files", () => {
    const t1 = makeTask({ id: 1, creates: ["a.ts"], modifies: ["b.ts"] });
    const t2 = makeTask({ id: 2, creates: ["c.ts"], modifies: ["d.ts"] });
    const s1 = makeSession({ id: "S1", tasks: [t1] });
    const s2 = makeSession({ id: "S2", tasks: [t2] });
    expect(hasSessionFileConflict(s1, s2)).toBe(false);
  });

  it("returns true when sessions both create the same file", () => {
    const t1 = makeTask({ id: 1, creates: ["src/index.ts"] });
    const t2 = makeTask({ id: 2, creates: ["src/index.ts"] });
    const s1 = makeSession({ id: "S1", tasks: [t1] });
    const s2 = makeSession({ id: "S2", tasks: [t2] });
    expect(hasSessionFileConflict(s1, s2)).toBe(true);
  });

  it("returns true when sessions both modify the same file", () => {
    const t1 = makeTask({ id: 1, modifies: ["package.json"] });
    const t2 = makeTask({ id: 2, modifies: ["package.json"] });
    const s1 = makeSession({ id: "S1", tasks: [t1] });
    const s2 = makeSession({ id: "S2", tasks: [t2] });
    expect(hasSessionFileConflict(s1, s2)).toBe(true);
  });

  it("returns true when one session creates and another modifies the same file", () => {
    const t1 = makeTask({ id: 1, creates: ["lib/utils.ts"] });
    const t2 = makeTask({ id: 2, modifies: ["lib/utils.ts"] });
    const s1 = makeSession({ id: "S1", tasks: [t1] });
    const s2 = makeSession({ id: "S2", tasks: [t2] });
    expect(hasSessionFileConflict(s1, s2)).toBe(true);
  });

  it("detects overlap across multiple tasks within each session", () => {
    const t1 = makeTask({ id: 1, creates: ["a.ts"] });
    const t2 = makeTask({ id: 2, creates: ["b.ts"] });
    const t3 = makeTask({ id: 3, creates: ["c.ts"] });
    const t4 = makeTask({ id: 4, creates: ["b.ts"] }); // conflicts with t2
    const s1 = makeSession({ id: "S1", tasks: [t1, t2] });
    const s2 = makeSession({ id: "S2", tasks: [t3, t4] });
    expect(hasSessionFileConflict(s1, s2)).toBe(true);
  });
});
