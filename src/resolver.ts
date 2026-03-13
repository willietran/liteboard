import type { Task, Layer, Session } from "./types.js";

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

// ─── Session Dependency Resolution ───────────────────────────────────────────

/**
 * For each session, collects all cross-session dependencies by inspecting
 * each task's `dependsOn` and checking if the referenced task lives in a
 * different session. Intra-session dependencies are ignored.
 *
 * Returns a map of session ID → list of unique dependency session IDs.
 */
export function resolveSessionDependencies(sessions: Session[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (sessions.length === 0) return result;

  // Build a lookup: task ID → session ID
  const taskOwner = new Map<number, string>();
  for (const session of sessions) {
    for (const task of session.tasks) {
      taskOwner.set(task.id, session.id);
    }
  }

  for (const session of sessions) {
    const depSessionIds = new Set<string>();
    for (const task of session.tasks) {
      for (const depId of task.dependsOn) {
        const ownerSessionId = taskOwner.get(depId);
        if (ownerSessionId !== undefined && ownerSessionId !== session.id) {
          depSessionIds.add(ownerSessionId);
        }
      }
    }
    result.set(session.id, [...depSessionIds]);
  }

  return result;
}

/**
 * Returns the subset of sessions that are ready to run: status is "queued"
 * and every dependency session has status "done". Sessions absent from the
 * deps map are treated as having no dependencies.
 */
export function getReadySessions(sessions: Session[], deps: Map<string, string[]>): Session[] {
  if (sessions.length === 0) return [];

  const sessionById = new Map<string, Session>();
  for (const session of sessions) {
    sessionById.set(session.id, session);
  }

  return sessions.filter((session) => {
    if (session.status !== "queued") return false;
    const sessionDeps = deps.get(session.id) ?? [];
    return sessionDeps.every((depId) => sessionById.get(depId)?.status === "done");
  });
}

/**
 * Returns true if sessions `a` and `b` touch any of the same files across
 * all their tasks (creates/modifies union overlap). Uses O(n) Set lookups.
 */
export function hasSessionFileConflict(a: Session, b: Session): boolean {
  const filesA = new Set<string>();
  for (const task of a.tasks) {
    for (const f of task.creates) filesA.add(f);
    for (const f of task.modifies) filesA.add(f);
  }
  for (const task of b.tasks) {
    for (const f of task.creates) {
      if (filesA.has(f)) return true;
    }
    for (const f of task.modifies) {
      if (filesA.has(f)) return true;
    }
  }
  return false;
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
