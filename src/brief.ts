import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task, ModelConfig, Provider } from "./types.js";
import { readMemorySnapshot } from "./memory.js";
import { artifactsDir } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.resolve(__dirname, "..", "commands");

export function readCommand(filename: string): string {
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

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/** Formats sub-agent model hint lines, handling Ollama's empty-hint case. */
export function formatSubagentHints(
  entries: { name: string; model: string }[],
  providerName: string,
  provider: Provider,
): string[] {
  return entries.map(({ name, model }) => {
    const hint = provider.subagentModelHint(model, providerName);
    if (hint) {
      return `- ${name} sub-agents: model: "${hint}"`;
    }
    return `- ${name} sub-agents: (inherits parent model \u2014 do not specify a model parameter)`;
  });
}

function appendSubagentModelsSection(
  parts: string[],
  entries: { name: string; model: string }[],
  providerName: string,
  models: ModelConfig | undefined,
  provider: Provider | undefined,
): void {
  if (!models || !provider) return;
  parts.push("## Sub-Agent Models");
  parts.push("When spawning sub-agents via the Agent tool, use these model settings:");
  parts.push(...formatSubagentHints(entries, providerName, provider));
  parts.push("");
}

function appendMemorySnapshot(parts: string[], projectDir: string): void {
  const memory = readMemorySnapshot(projectDir);
  if (memory && /^## T\d+/m.test(memory)) {
    parts.push("**Build Memory** (context from completed tasks):");
    parts.push("```");
    parts.push(memory.trim());
    parts.push("```");
    parts.push("");
  }
}

function appendTaskDetails(parts: string[], task: Task): void {
  parts.push("**Task details:**");
  if (task.creates.length > 0)
    parts.push(`- Creates: ${task.creates.map((f) => `\`${f}\``).join(", ")}`);
  if (task.modifies.length > 0)
    parts.push(`- Modifies: ${task.modifies.map((f) => `\`${f}\``).join(", ")}`);
  if (task.requirements.length > 0) {
    parts.push("- Requirements:");
    for (const r of task.requirements) parts.push(`  - ${r}`);
  }
  parts.push("");
}

// ─── Backward-Compatible Dispatcher ──────────────────────────────────────────

export function buildBrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designPath: string,
  manifestPath: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  if (task.type === "qa") {
    return buildQABrief(task, allTasks, projectDir, designPath, manifestPath, featureBranch, models, provider);
  }
  return buildImplementationBrief(task, allTasks, projectDir, designPath, manifestPath, featureBranch, models, provider);
}

// ─── Architect Brief ─────────────────────────────────────────────────────────

export function buildArchitectBrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designPath: string,
  manifestPath: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  const slug = path.basename(projectDir);
  const artDir = artifactsDir(projectDir);
  const parts: string[] = [];

  // 1. Architect orientation
  parts.push(readCommand("architect-orientation.md"));
  parts.push("");

  // 2. Sub-agent model hints (explore + planReview)
  appendSubagentModelsSection(parts, [
    { name: "Explore", model: models?.architect.subagents.explore?.model ?? "" },
    { name: "Plan Review", model: models?.architect.subagents.planReview?.model ?? "" },
  ], models?.architect.provider ?? "claude", models, provider);

  // 3. Quality standards
  parts.push(readCommand("quality-standards.md"));
  parts.push("");

  // 4. Task context
  parts.push("---");
  parts.push(`I'm planning **Task ${task.id}: ${task.title}** for the **${slug}** project.`);
  parts.push("");

  // 5. Reference docs
  parts.push("**Reference documents** (read these first):");
  parts.push(`- Design doc: \`${designPath}\``);
  parts.push(`- Task manifest: \`${manifestPath}\``);
  parts.push("");

  // 6. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 7. Explore hints
  const hints = inferExploreHints(task, allTasks);
  if (hints.length > 0) {
    parts.push("**Explore hints:**");
    for (const h of hints) parts.push(`- ${h}`);
    parts.push("");
  }

  // 8. Task details
  appendTaskDetails(parts, task);

  // 9. Workflow: plan review with supporting documents
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push("### Plan Review");
  parts.push(readCommand("plan-review.md"));
  parts.push("");
  parts.push("### How to process review feedback:");
  parts.push(readCommand("receiving-code-review.md"));
  parts.push("");
  parts.push("### Review criteria:");
  parts.push(readCommand("code-reviewer.md"));
  parts.push("");

  // 10. Plan output instruction
  parts.push("### Plan Output");
  parts.push(`Write your approved plan to \`${artDir}/t${task.id}-task-plan.md\`.`);
  parts.push("");

  // 11. Rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this task");
  parts.push("- Do NOT push to remote");
  parts.push("- Do NOT write implementation code — your output is a plan, not a diff");
  parts.push("- Do NOT commit — your output is a plan file only");
  parts.push(`- Write your memory entry to \`${artDir}/t${task.id}-memory-entry.md\` as your final step`);
  parts.push(`- Save any generated artifacts (screenshots, reports) to \`${artDir}/\` — never to the repo root`);
  parts.push("");

  return parts.join("\n");
}

// ─── Implementation Brief ────────────────────────────────────────────────────

export function buildImplementationBrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designPath: string,
  manifestPath: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  const slug = path.basename(projectDir);
  const artDir = artifactsDir(projectDir);
  const parts: string[] = [];

  // 1. Agent orientation (implement/verify/review phases)
  parts.push(readCommand("agent-orientation.md"));
  parts.push("");

  // 2. Sub-agent model hints (codeReview only)
  appendSubagentModelsSection(parts, [
    { name: "Code Review", model: models?.implementation.subagents.codeReview?.model ?? "" },
  ], models?.implementation.provider ?? "claude", models, provider);

  // 3. Quality standards
  parts.push(readCommand("quality-standards.md"));
  parts.push("");

  // 4. Task context
  parts.push("---");
  parts.push(`I'm implementing **Task ${task.id}: ${task.title}** for the **${slug}** project.`);
  parts.push("");

  // 5. Reference docs
  parts.push("**Reference documents** (read these first):");
  parts.push(`- Design doc: \`${designPath}\``);
  parts.push(`- Task manifest: \`${manifestPath}\``);
  parts.push("");

  // 6. Plan read instruction
  parts.push(`**Task plan** (read before implementing):`);
  parts.push(`- Read the approved plan from \`${artDir}/t${task.id}-task-plan.md\``);
  parts.push("");

  // 7. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 8. Task details
  appendTaskDetails(parts, task);

  // 9. Workflow: implement → verify → code review
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push("### Phase 1: Implement");
  if (task.tddPhase && task.tddPhase !== "Exempt") {
    parts.push(`This is a TDD task (${task.tddPhase}). Write a failing test first, verify it fails (RED), then write the minimum implementation to make it pass (GREEN), then refactor. Verify the test suite after each step. Skipping RED verification or writing implementation before tests is a **BLOCKING violation**.`);
  } else {
    parts.push("This task is **TDD-Exempt**. Tests are encouraged but not required first.");
  }
  parts.push("");
  parts.push("### Phase 2: Verify");
  parts.push(readCommand("verification.md"));
  parts.push("");
  parts.push("### Phase 3: Code Review");
  parts.push(readCommand("session-review.md"));
  parts.push("");
  parts.push("### How to process review feedback:");
  parts.push(readCommand("receiving-code-review.md"));
  parts.push("");
  parts.push("### Review criteria:");
  parts.push(readCommand("code-reviewer.md"));
  parts.push("");

  // 10. Commit message + rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(`- **Commit message** (use exactly): \`${task.commitMessage}\``);
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this task");
  parts.push("- Do NOT push to remote");
  parts.push(`- Write your memory entry to \`${artDir}/t${task.id}-memory-entry.md\` as your final step before committing`);
  parts.push(`- Save any generated artifacts (screenshots, reports) to \`${artDir}/\` — never to the repo root`);
  parts.push("");

  return parts.join("\n");
}

// ─── QA Brief ────────────────────────────────────────────────────────────────

function buildQABrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designPath: string,
  manifestPath: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  const slug = path.basename(projectDir);
  const parts: string[] = [];

  // 1. Agent orientation + quality standards
  parts.push(readCommand("agent-orientation.md"));
  parts.push("");

  // 2. Sub-agent model hints (qaFixer only)
  appendSubagentModelsSection(parts, [
    { name: "Fixer", model: models?.qa.subagents.qaFixer?.model ?? "" },
  ], models?.qa.provider ?? "claude", models, provider);

  parts.push(readCommand("quality-standards.md"));
  parts.push("");

  // 3. Task context
  parts.push("---");
  parts.push(`I'm the **QA agent** for **Task ${task.id}: ${task.title}** in the **${slug}** project.`);
  parts.push("");

  // 4. Reference docs
  parts.push("**Reference documents** (read these first):");
  parts.push(`- Design doc: \`${designPath}\``);
  parts.push(`- Task manifest: \`${manifestPath}\``);
  parts.push("");

  // 5. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 6. Dependency task details
  const depTasks = task.dependsOn
    .map(id => allTasks.find(t => t.id === id))
    .filter((t): t is Task => t !== undefined);

  if (depTasks.length > 0) {
    parts.push("## What to Validate");
    parts.push("");
    for (const dep of depTasks) {
      parts.push(`### Task ${dep.id}: ${dep.title}`);
      if (dep.creates.length > 0) {
        parts.push(`- Creates: ${dep.creates.map(f => `\`${f}\``).join(", ")}`);
      }
      if (dep.modifies.length > 0) {
        parts.push(`- Modifies: ${dep.modifies.map(f => `\`${f}\``).join(", ")}`);
      }
      if (dep.requirements.length > 0) {
        parts.push("- Requirements:");
        for (const req of dep.requirements) {
          parts.push(`  - ${req}`);
        }
      }
      parts.push("");
    }
  }

  // 7. QA workflow
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push(readCommand("qa-agent.md"));
  parts.push("");

  // 8. Rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(`- **Commit message** (use exactly): \`${task.commitMessage}\``);
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this task");
  parts.push("- Do NOT push to remote");
  const artDir = artifactsDir(projectDir);
  parts.push(`- If you made code fixes, write memory entry to \`${artDir}/t${task.id}-memory-entry.md\` summarizing what you fixed`);
  parts.push(`- **Always** write QA report to \`${artDir}/t${task.id}-qa-report.md\` with a markdown table of all tests and results`);
  parts.push(`- Save any generated artifacts (screenshots, reports) to \`${artDir}/\` — never to the repo root`);
  parts.push("- Use standard `[STAGE: ...]` markers as described in the workflow above");
  parts.push("");

  return parts.join("\n");
}
