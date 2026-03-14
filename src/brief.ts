import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task, Session, ModelConfig, Provider } from "./types.js";
import { LOW_COMPLEXITY_THRESHOLD } from "./types.js";
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
  if (memory && /^## [TS]\w+/m.test(memory)) {
    parts.push("**Build Memory** (context from completed tasks):");
    parts.push("```");
    parts.push(memory.trim());
    parts.push("```");
    parts.push("");
  }
}

function appendInlineDocs(parts: string[], designDoc: string, manifest: string): void {
  if (designDoc) {
    parts.push("## Design Document");
    parts.push("");
    parts.push(designDoc.trim());
    parts.push("");
  }
  if (manifest) {
    parts.push("## Task Manifest");
    parts.push("");
    parts.push(manifest.trim());
    parts.push("");
  }
}

function extractTaskEntry(lines: string[], taskId: number): string {
  const taskHeaderRegex = /^### Task (\d+):/;
  const phaseHeaderRegex = /^## Phase\b/;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(taskHeaderRegex);
    if (match && parseInt(match[1]) === taskId) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return "";

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (taskHeaderRegex.test(lines[i]) || phaseHeaderRegex.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n").trimEnd();
}

function findTaskPhase(lines: string[], taskId: number): string {
  const phaseRegex = /^## (Phase \d+: .+)/;
  const taskRegex = /^### Task (\d+):/;
  let lastPhase = "";

  for (const line of lines) {
    const phaseMatch = line.match(phaseRegex);
    if (phaseMatch) lastPhase = phaseMatch[1];
    const taskMatch = line.match(taskRegex);
    if (taskMatch && parseInt(taskMatch[1]) === taskId) return lastPhase;
  }
  return "";
}

export function buildManifestExcerpt(task: Task, manifest: string): string {
  if (!manifest) return "";

  const lines = manifest.split("\n");
  const parts: string[] = [];

  // 1. Extract header (everything before first "## Phase" or "### Task")
  const headerEnd = lines.findIndex(
    (l) => /^## Phase\b/.test(l) || /^### Task \d+:/.test(l),
  );
  const header = lines
    .slice(0, headerEnd >= 0 ? headerEnd : lines.length)
    .join("\n")
    .trimEnd();
  if (header) parts.push(header);

  // 2. One-line summary: total task count + current task's phase
  const taskHeaders = lines.filter((l) => /^### Task \d+:/.test(l));
  const taskCount = taskHeaders.length;
  if (taskCount > 0) {
    const phase = findTaskPhase(lines, task.id);
    const summary = phase
      ? `**${taskCount} tasks total** — this task is in ${phase}`
      : `**${taskCount} tasks total**`;
    parts.push("");
    parts.push(summary);
  }

  // 3. Extract this task's entry
  const ownEntry = extractTaskEntry(lines, task.id);
  if (ownEntry) {
    parts.push("");
    parts.push(ownEntry);
  }

  // 4. Extract direct dependency entries
  for (const depId of task.dependsOn) {
    const depEntry = extractTaskEntry(lines, depId);
    if (depEntry) {
      parts.push("");
      parts.push(depEntry);
    }
  }

  return parts.join("\n");
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

/** @internal — only used by tests; production code uses session-level variants. */
export function buildBrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  if (task.type === "qa") {
    return buildQABrief(task, allTasks, projectDir, designDoc, manifest, featureBranch, models, provider);
  }
  return buildImplementationBrief(task, allTasks, projectDir, designDoc, manifest, featureBranch, models, provider);
}

// ─── Architect Brief ─────────────────────────────────────────────────────────

/** @internal — only used by tests; production code uses session-level variants. */
export function buildArchitectBrief(
  task: Task,
  allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  const slug = path.basename(projectDir);
  const artDir = artifactsDir(projectDir);
  const parts: string[] = [];

  // SHARED prefix (cache-friendly):
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

  // 4. Workflow: plan review with supporting documents
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push("### Plan Review");
  parts.push(readCommand("plan-review.md"));
  parts.push("");
  parts.push("### How to process review feedback:");
  parts.push(readCommand("receiving-code-review.md"));
  parts.push("");

  // 5. Design doc (inlined)
  // 6. Manifest excerpt (inlined, scoped to task + direct deps)
  appendInlineDocs(parts, designDoc, buildManifestExcerpt(task, manifest));

  // --- cache boundary ---
  // TASK-SPECIFIC:
  // 7. Task context
  parts.push("---");
  parts.push(`I'm planning **Task ${task.id}: ${task.title}** for the **${slug}** project.`);
  parts.push("");

  // 8. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 9. Explore targets
  const exploreTargets = task.explore.length > 0 ? task.explore : inferExploreHints(task, allTasks);
  if (exploreTargets.length > 0) {
    parts.push("**Explore targets:**");
    for (const t of exploreTargets) parts.push(`- ${t}`);
    parts.push("");
  }

  // 9.5. Tool usage constraints for architect subagents
  parts.push("**Tool Usage Constraints:**");
  parts.push("You may use Bash for: git log, git diff, git status, ls, file inspection. Do NOT use Bash to execute project code (node, npm, npx, python, tsc, etc.). node_modules is never installed in worktrees at planning time. Use documentation tools (context7, WebFetch, WebSearch) to verify library APIs.");
  parts.push("");

  // 10. Task details
  appendTaskDetails(parts, task);

  // 11. Plan output instruction
  parts.push("### Plan Output");
  parts.push(`Write your approved plan to \`${artDir}/t${task.id}-task-plan.md\`.`);
  parts.push("");

  // 12. Rules
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

/** @internal — only used by tests; production code uses session-level variants. */
export function buildImplementationBrief(
  task: Task,
  _allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  const slug = path.basename(projectDir);
  const artDir = artifactsDir(projectDir);
  const parts: string[] = [];

  // SHARED prefix (cache-friendly):
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

  // 4. Shell anti-patterns
  parts.push(readCommand("shell-anti-patterns.md"));
  parts.push("");

  // 5. Workflow: implement → verify → code review
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

  // 6. Design doc (inlined)
  // 7. Manifest excerpt (inlined, scoped to task + direct deps)
  appendInlineDocs(parts, designDoc, buildManifestExcerpt(task, manifest));

  // --- cache boundary ---
  // TASK-SPECIFIC:
  // 8. Task context
  parts.push("---");
  parts.push(`I'm implementing **Task ${task.id}: ${task.title}** for the **${slug}** project.`);
  parts.push("");

  // 9. Plan read instruction (only when architect phase produced a plan)
  if (task.complexity > LOW_COMPLEXITY_THRESHOLD) {
    parts.push(`**Task plan** (read before implementing):`);
    parts.push(`- Read the approved plan from \`${artDir}/t${task.id}-task-plan.md\``);
    parts.push("");
  }

  // 10. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 11. Task details
  appendTaskDetails(parts, task);

  // 12. Commit message + rules
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
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
  artifactPrefix?: string,
): string {
  const slug = path.basename(projectDir);
  const parts: string[] = [];

  // SHARED prefix (cache-friendly):
  // 1. Agent orientation + quality standards
  parts.push(readCommand("agent-orientation.md"));
  parts.push("");

  // 2. Sub-agent model hints (qaFixer only)
  appendSubagentModelsSection(parts, [
    { name: "Fixer", model: models?.qa.subagents.qaFixer?.model ?? "" },
  ], models?.qa.provider ?? "claude", models, provider);

  // 3. Quality standards
  parts.push(readCommand("quality-standards.md"));
  parts.push("");

  // 4. Shell anti-patterns
  parts.push(readCommand("shell-anti-patterns.md"));
  parts.push("");

  // 5. QA workflow
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push(readCommand("qa-agent.md"));
  parts.push("");

  // 6. Design doc (inlined)
  // 7. Manifest (inlined)
  appendInlineDocs(parts, designDoc, manifest);

  // --- cache boundary ---
  // TASK-SPECIFIC:
  // 8. Task context
  parts.push("---");
  parts.push(`I'm the **QA agent** for **Task ${task.id}: ${task.title}** in the **${slug}** project.`);
  parts.push("");

  // 9. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 10. Dependency task details
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

  // 11. Rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(`- **Commit message** (use exactly): \`${task.commitMessage}\``);
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this task");
  parts.push("- Do NOT push to remote");
  const artDir = artifactsDir(projectDir);
  const prefix = artifactPrefix ?? `t${task.id}`;
  parts.push(`- If you made code fixes, write memory entry to \`${artDir}/${prefix}-memory-entry.md\` summarizing what you fixed`);
  parts.push(`- **Always** write QA report to \`${artDir}/${prefix}-qa-report.md\` with a markdown table of all tests and results`);
  parts.push(`- Save any generated artifacts (screenshots, reports) to \`${artDir}/\` — never to the repo root`);
  parts.push("- Use standard `[STAGE: ...]` markers as described in the workflow above");
  parts.push("");

  return parts.join("\n");
}

// ─── Session Briefs ───────────────────────────────────────────────────────────

export function buildSessionArchitectBrief(
  session: Session,
  allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
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

  // 4. Workflow: plan review
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push("### Plan Review");
  parts.push(readCommand("plan-review.md"));
  parts.push("");
  parts.push("### How to process review feedback:");
  parts.push(readCommand("receiving-code-review.md"));
  parts.push("");

  // 5. Design doc (full, not scoped)
  // 6. Manifest excerpt for each task in session (concatenated)
  const architectManifestExcerpts = session.tasks.map((t) => buildManifestExcerpt(t, manifest)).filter(Boolean).join("\n");
  appendInlineDocs(parts, designDoc, architectManifestExcerpts);

  // --- cache boundary ---
  // 7. Session context
  parts.push("---");
  parts.push(`I'm planning **Session ${session.id}: ${session.focus}** for the **${slug}** project.`);
  parts.push("");

  // 8. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 9. Explore targets + tool constraints
  const allExploreTargets: string[] = [];
  for (const task of session.tasks) {
    const targets = task.explore.length > 0 ? task.explore : inferExploreHints(task, allTasks);
    allExploreTargets.push(...targets);
  }
  const uniqueTargets = [...new Set(allExploreTargets)];
  if (uniqueTargets.length > 0) {
    parts.push("**Explore targets:**");
    for (const t of uniqueTargets) parts.push(`- ${t}`);
    parts.push("");
  }

  parts.push("**Tool Usage Constraints:**");
  parts.push("You may use Bash for: git log, git diff, git status, ls, file inspection. Do NOT use Bash to execute project code (node, npm, npx, python, tsc, etc.). node_modules is never installed in worktrees at planning time. Use documentation tools (context7, WebFetch, WebSearch) to verify library APIs.");
  parts.push("");

  // 10. Task details for each task in session
  parts.push("**Session tasks:**");
  parts.push("");
  for (const task of session.tasks) {
    parts.push(`### Task ${task.id}: ${task.title}`);
    if (task.creates.length > 0)
      parts.push(`- Creates: ${task.creates.map((f) => `\`${f}\``).join(", ")}`);
    if (task.modifies.length > 0)
      parts.push(`- Modifies: ${task.modifies.map((f) => `\`${f}\``).join(", ")}`);
    if (task.requirements.length > 0) {
      parts.push("- Requirements:");
      for (const r of task.requirements) parts.push(`  - ${r}`);
    }
    if (task.explore.length > 0) {
      parts.push("- Explore:");
      for (const e of task.explore) parts.push(`  - ${e}`);
    }
    parts.push("");
  }

  // 11. Plan output instruction
  parts.push("### Plan Output");
  parts.push(`Write your approved plan to \`${artDir}/s${session.id}-session-plan.md\`.`);
  parts.push("");

  // 12. Rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this session");
  parts.push("- Do NOT push to remote");
  parts.push("- Do NOT write implementation code — your output is a plan, not a diff");
  parts.push("- Do NOT commit — your output is a plan file only");
  parts.push(`- Write your memory entry to \`${artDir}/s${session.id}-memory-entry.md\` as your final step`);
  parts.push(`- Save any generated artifacts (screenshots, reports) to \`${artDir}/\` — never to the repo root`);
  parts.push("");

  return parts.join("\n");
}

export function buildSessionImplementationBrief(
  session: Session,
  allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  const slug = path.basename(projectDir);
  const artDir = artifactsDir(projectDir);
  const parts: string[] = [];

  // 1. Agent orientation
  parts.push(readCommand("agent-orientation.md"));
  parts.push("");

  // 2. Sub-agent model hints (codeReview only)
  appendSubagentModelsSection(parts, [
    { name: "Code Review", model: models?.implementation.subagents.codeReview?.model ?? "" },
  ], models?.implementation.provider ?? "claude", models, provider);

  // 3. Quality standards
  parts.push(readCommand("quality-standards.md"));
  parts.push("");

  // 4. Shell anti-patterns
  parts.push(readCommand("shell-anti-patterns.md"));
  parts.push("");

  // 5. Workflow
  parts.push("---");
  parts.push("## Workflow");
  parts.push("");
  parts.push("### Phase 1: Implement");
  const tddTasks = session.tasks.filter((t) => t.tddPhase && t.tddPhase !== "Exempt");
  if (tddTasks.length > 0) {
    parts.push("This session contains TDD tasks. For each task that specifies a TDD phase, write failing tests first (RED), verify failure, then implement (GREEN), then refactor. Non-TDD tasks: tests encouraged but not required first.");
  } else {
    parts.push("This session is **TDD-Exempt**. Tests are encouraged but not required first.");
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

  // 6. Design doc (full)
  // 7. Manifest excerpt for each task in session (concatenated)
  const implManifestExcerpts = session.tasks.map((t) => buildManifestExcerpt(t, manifest)).filter(Boolean).join("\n");
  appendInlineDocs(parts, designDoc, implManifestExcerpts);

  // --- cache boundary ---
  // 8. Session context
  parts.push("---");
  parts.push(`I'm implementing **Session ${session.id}: ${session.focus}** for the **${slug}** project.`);
  parts.push("");

  // 9. Plan read instruction (if any task has complexity > LOW_COMPLEXITY_THRESHOLD)
  const needsPlan = session.tasks.some((t) => t.complexity > LOW_COMPLEXITY_THRESHOLD);
  if (needsPlan) {
    parts.push(`**Session plan** (read before implementing):`);
    parts.push(`- Read the approved plan from \`${artDir}/s${session.id}-session-plan.md\` before implementing.`);
    parts.push("");
  }

  // 10. Memory snapshot
  appendMemorySnapshot(parts, projectDir);

  // 11. All tasks in order with their details and commit messages
  for (const task of session.tasks) {
    parts.push(`### Task ${task.id}: ${task.title}`);
    if (task.creates.length > 0)
      parts.push(`- Creates: ${task.creates.map((f) => `\`${f}\``).join(", ")}`);
    if (task.modifies.length > 0)
      parts.push(`- Modifies: ${task.modifies.map((f) => `\`${f}\``).join(", ")}`);
    if (task.requirements.length > 0) {
      parts.push("- Requirements:");
      for (const r of task.requirements) parts.push(`  - ${r}`);
    }
    parts.push(`- **Commit message** (use exactly): \`${task.commitMessage}\``);
    parts.push("");
  }

  // 12. Rules
  parts.push("---");
  parts.push("## Rules");
  parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Do NOT touch files unrelated to this session");
  parts.push("- Do NOT push to remote");
  parts.push("- Commit after each task using the specified commit message");
  parts.push(`- Write your memory entry to \`${artDir}/s${session.id}-memory-entry.md\` as your final step before committing`);
  parts.push(`- Save any generated artifacts (screenshots, reports) to \`${artDir}/\` — never to the repo root`);
  parts.push("");

  return parts.join("\n");
}

function buildSessionQABrief(
  session: Session,
  allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  // QA sessions typically have 1 task — delegate with session-scoped artifact prefix
  return buildQABrief(session.tasks[0], allTasks, projectDir, designDoc, manifest, featureBranch, models, provider, `s${session.id}`);
}

export function buildSessionBrief(
  session: Session,
  allTasks: Task[],
  projectDir: string,
  designDoc: string,
  manifest: string,
  featureBranch: string,
  models?: ModelConfig,
  provider?: Provider,
): string {
  if (session.tasks.every((t) => t.type === "qa")) {
    return buildSessionQABrief(session, allTasks, projectDir, designDoc, manifest, featureBranch, models, provider);
  }
  return buildSessionImplementationBrief(session, allTasks, projectDir, designDoc, manifest, featureBranch, models, provider);
}
