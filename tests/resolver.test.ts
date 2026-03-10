import { describe, it, expect } from "vitest";
import { topologicalSort, hasFileConflict } from "../src/resolver.js";
import type { Task } from "../src/types.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeTask(partial: Partial<Task> & { id: number }): Task {
  return {
    title: `Task ${partial.id}`,
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    tddPhase: "green",
    commitMessage: "",
    complexity: 1,
    status: "blocked",
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
