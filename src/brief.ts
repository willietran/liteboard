import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./types.js";
import { readMemorySnapshot } from "./memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.resolve(__dirname, "..", "commands");

function readCommand(filename: string): string {
  const filePath = path.join(commandsDir, filename);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing command file: ${filename}. Expected at ${filePath}. Is liteboard installed correctly?`);
    }
    throw e;
  }
}

function inferExploreHints(task: Task, allTasks: Task[]): string[] {
  const hints: string[] = [];
  // Files this task creates/modifies
  for (const f of [...task.creates, ...task.modifies]) {
    const dir = path.dirname(f);
    if (dir !== ".") hints.push(`Explore ${dir}/ for existing patterns`);
  }
  // Files from dependency tasks
  for (const depId of task.dependsOn) {
    const dep = allTasks.find((t) => t.id === depId);
    if (dep) {
      for (const f of dep.creates) {
        hints.push(`Read ${f} (created by Task ${depId}: ${dep.title})`);
      }
    }
  }
  return [...new Set(hints)];
}

export function buildBrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designPath: string,
  manifestPath: string,
  featureBranch: string,
): string {
  const slug = path.basename(projectDir);
  const parts: string[] = [];

  // 1. Agent orientation
  parts.push(readCommand("agent-orientation.md"));
  parts.push("");

  // 2. Task context
  parts.push(`---`);
  parts.push(
    `I'm implementing **Task ${task.id}: ${task.title}** for the **${slug}** project.`,
  );
  parts.push("");

  // 3. Design doc + manifest paths
  parts.push("**Reference documents** (read these first):");
  parts.push(`- Design doc: \`${designPath}\``);
  parts.push(`- Task manifest: \`${manifestPath}\``);
  parts.push("");

  // 4. Memory snapshot
  const memory = readMemorySnapshot(projectDir);
  if (memory && /^## T\d+/m.test(memory)) {
    parts.push("**Build Memory** (context from completed tasks):");
    parts.push("```");
    parts.push(memory.trim());
    parts.push("```");
    parts.push("");
  }

  // 5. Explore hints
  const hints = inferExploreHints(task, allTasks);
  if (hints.length > 0) {
    parts.push("**Explore hints:**");
    for (const h of hints) parts.push(`- ${h}`);
    parts.push("");
  }

  // 6. Task details
  parts.push("**Task details:**");
  if (task.creates.length > 0)
    parts.push(
      `- Creates: ${task.creates.map((f) => `\`${f}\``).join(", ")}`,
    );
  if (task.modifies.length > 0)
    parts.push(
      `- Modifies: ${task.modifies.map((f) => `\`${f}\``).join(", ")}`,
    );
  if (task.requirements.length > 0) {
    parts.push("- Requirements:");
    for (const r of task.requirements) parts.push(`  - ${r}`);
  }
  parts.push("");

  // 7. Workflow phases with embedded commands
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push("### Phase 1-2: Explore & Plan, then Plan Review");
  parts.push(readCommand("plan-review.md"));
  parts.push("");
  parts.push("### Phase 3: Implement");
  if (task.tddPhase && task.tddPhase !== "Exempt") {
    parts.push(`This is a TDD task. Follow: ${task.tddPhase}`);
  }
  parts.push("");
  parts.push("### Phase 4: Code Review");
  parts.push(readCommand("session-review.md"));
  parts.push("");
  parts.push("### How to process review feedback:");
  parts.push(readCommand("receiving-code-review.md"));
  parts.push("");
  parts.push("### Review criteria:");
  parts.push(readCommand("code-reviewer.md"));
  parts.push("");

  // 8. Commit message + rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(
    `- **Commit message** (use exactly): \`${task.commitMessage}\``,
  );
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this task");
  parts.push("- Do NOT push to remote");
  parts.push(
    "- Write `.memory-entry.md` as your final step before committing",
  );
  parts.push("");

  return parts.join("\n");
}
