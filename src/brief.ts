import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task, FixerErrorContext } from "./types.js";
import { readMemorySnapshot } from "./memory.js";

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

  // 1.5. Quality standards
  parts.push(readCommand("quality-standards.md"));
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
    parts.push(`This is a TDD task (${task.tddPhase}). Write a failing test first, verify it fails (RED), then write the minimum implementation to make it pass (GREEN), then refactor. Verify the test suite after each step. Skipping RED verification or writing implementation before tests is a **BLOCKING violation**.`);
  } else {
    parts.push("This task is **TDD-Exempt**. Tests are encouraged but not required first.");
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
  parts.push("- Before code review, verify: `npx tsc --noEmit` && `npm run build` && `npm test` all pass");
  parts.push("");

  return parts.join("\n");
}

// ─── Fixer Error Formatting ───────────────────────────────────────────────────

export function formatFixerErrors(ctx: FixerErrorContext): string {
  const sections: string[] = [];

  // Build phase
  if (ctx.buildResult.success) {
    sections.push("### Build Phase: PASSED");
  } else {
    sections.push(`### Build Phase: FAILED at \`${ctx.buildResult.failedPhase}\``);
    if (ctx.buildResult.tscErrorCount > 0) {
      sections.push(`- TypeScript errors: ${ctx.buildResult.tscErrorCount}`);
    }
    if (ctx.buildResult.testFailCount > 0) {
      sections.push(`- Test failures: ${ctx.buildResult.testFailCount} (${ctx.buildResult.testPassCount} passed)`);
    }
    if (ctx.buildResult.stderr) {
      const previewLines = ctx.buildResult.stderr.split("\n").slice(0, 30);
      sections.push("```");
      sections.push(previewLines.join("\n"));
      sections.push("```");
    }
  }

  // Smoke test phase
  if (ctx.smokeResult) {
    if (ctx.smokeResult.success) {
      sections.push("### Smoke Test: PASSED");
    } else {
      sections.push("### Smoke Test: FAILED");
      sections.push(`- ${ctx.smokeResult.error ?? "Unknown error"}`);
      if (ctx.smokeResult.appUrl) {
        sections.push(`- App URL: ${ctx.smokeResult.appUrl}`);
      }
    }
  }

  // QA phase
  if (ctx.qaReport) {
    if (ctx.qaReport.totalFailed === 0) {
      sections.push(`### QA Phase: PASSED (${ctx.qaReport.totalPassed} features verified)`);
    } else {
      sections.push(`### QA Phase: ${ctx.qaReport.totalFailed} of ${ctx.qaReport.totalPassed + ctx.qaReport.totalFailed} features failed`);
      for (const f of ctx.qaReport.features) {
        if (!f.passed) {
          sections.push(`- [QA:FAIL] ${f.name}${f.error ? `: ${f.error}` : ""}`);
        }
      }
    }
  }

  return sections.join("\n");
}

// ─── Fixer Brief ─────────────────────────────────────────────────────────────

export function buildFixerBrief(
  errorContext: FixerErrorContext,
  diff: string,
  tasks: Task[],
  projectDir: string,
  designPath?: string,
  manifestPath?: string,
  featureBranch?: string,
): string {
  const parts: string[] = [];

  // Fixer agent instructions
  parts.push(readCommand("fixer-agent.md"));
  parts.push("");

  // Structured error context
  parts.push("---");
  parts.push("## Errors to Fix");
  parts.push(formatFixerErrors(errorContext));
  parts.push("");

  // Reference documents
  if (designPath || manifestPath) {
    parts.push("**Reference documents:**");
    if (designPath) parts.push(`- Design doc: \`${designPath}\``);
    if (manifestPath) parts.push(`- Task manifest: \`${manifestPath}\``);
    parts.push("");
  }

  // Task summary
  parts.push("## Task Manifest Summary");
  for (const task of tasks) {
    parts.push(`- **Task ${task.id}: ${task.title}**`);
    if (task.creates.length > 0) {
      parts.push(`  Creates: ${task.creates.map(f => `\`${f}\``).join(", ")}`);
    }
    if (task.modifies.length > 0) {
      parts.push(`  Modifies: ${task.modifies.map(f => `\`${f}\``).join(", ")}`);
    }
  }
  parts.push("");

  // Diff context (truncated if massive)
  if (diff) {
    const maxDiffLines = 500;
    const diffLines = diff.split("\n");
    parts.push("## Current Diff (main...HEAD)");
    parts.push("```diff");
    if (diffLines.length > maxDiffLines) {
      parts.push(diffLines.slice(0, maxDiffLines).join("\n"));
      parts.push(`... (truncated, ${diffLines.length - maxDiffLines} more lines)`);
    } else {
      parts.push(diff.trim());
    }
    parts.push("```");
    parts.push("");
  }

  // Rules
  parts.push("---");
  parts.push("## Rules");
  if (featureBranch) parts.push(`- **Feature branch**: \`${featureBranch}\``);
  parts.push("- Commit each fix with: `fix(integration): <description>`");
  parts.push("- Do NOT push to remote");
  parts.push("- Do NOT modify test expectations — fix the implementation");
  parts.push("");

  return parts.join("\n");
}
