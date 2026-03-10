import type { Task, Layer } from "./types.js";

// ─── File Conflict Detection ─────────────────────────────────────────────────

/**
 * Returns true if tasks `a` and `b` touch any of the same files
 * (creates/modifies overlap in any combination).
 */
export function hasFileConflict(a: Task, b: Task): boolean {
  const filesA = new Set([...a.creates, ...a.modifies]);
  const filesB = [...b.creates, ...b.modifies];
  return filesB.some((f) => filesA.has(f));
}

// ─── Topological Sort (Kahn's Algorithm) with File-Conflict Splitting ────────

/**
 * Produces execution layers via Kahn's algorithm.
 * Each layer contains task IDs that can execute in parallel — unless they have
 * file conflicts, in which case conflicting tasks are split into sequential
 * sub-layers with the lower ID first.
 *
 * Throws a descriptive error when a circular dependency is detected.
 */
export function topologicalSort(tasks: Task[]): Layer[] {
  if (tasks.length === 0) return [];

  const taskMap = new Map<number, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // Build in-degree map and adjacency list (forward edges: dep -> dependent)
  const inDegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();

  for (const t of tasks) {
    inDegree.set(t.id, t.dependsOn.length);
    if (!dependents.has(t.id)) dependents.set(t.id, []);
    for (const dep of t.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(t.id);
    }
  }

  // Kahn's: seed the queue with in-degree-zero nodes
  let currentIds: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) currentIds.push(id);
  }
  currentIds.sort((a, b) => a - b); // deterministic ordering

  const rawLayers: number[][] = [];
  let processed = 0;

  while (currentIds.length > 0) {
    rawLayers.push(currentIds);
    processed += currentIds.length;

    const nextSet = new Set<number>();
    for (const id of currentIds) {
      for (const dep of dependents.get(id) ?? []) {
        const newDeg = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) nextSet.add(dep);
      }
    }

    currentIds = [...nextSet].sort((a, b) => a - b);
  }

  if (processed !== tasks.length) {
    const stuck = tasks
      .filter((t) => inDegree.get(t.id)! > 0)
      .map((t) => t.id);
    throw new Error(
      `Circular dependency detected among tasks: [${stuck.join(", ")}]`
    );
  }

  // ── Split layers that contain file conflicts ─────────────────────────────
  const layers: Layer[] = [];
  let layerIndex = 0;

  for (const ids of rawLayers) {
    const subLayers = splitConflicts(ids, taskMap);
    for (const sub of subLayers) {
      layers.push({ layerIndex, taskIds: sub });
      layerIndex++;
    }
  }

  return layers;
}

// ─── Internal: split a set of task IDs into sub-layers by file conflicts ─────

function splitConflicts(
  ids: number[],
  taskMap: Map<number, Task>
): number[][] {
  if (ids.length <= 1) return [ids];

  const subLayers: number[][] = [];

  for (const id of ids) {
    const task = taskMap.get(id);
    if (!task) throw new Error(`splitConflicts: task ${id} not found in taskMap`);
    let placed = false;

    for (const sub of subLayers) {
      const conflicts = sub.some((existingId) => {
        const existing = taskMap.get(existingId);
        if (!existing) throw new Error(`splitConflicts: task ${existingId} not found in taskMap`);
        return hasFileConflict(existing, task);
      });
      if (!conflicts) {
        sub.push(id);
        placed = true;
        break;
      }
    }

    if (!placed) {
      subLayers.push([id]);
    }
  }

  return subLayers;
}
