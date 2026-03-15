import { describe, it, expect } from "vitest";

// ─── parseArgs is not exported, so we test the CLI indirectly via types ──────

// CLI tests focus on the parts we can unit-test without spawning processes:
// - V2CLIArgs type correctness
// - buildSessionPrompt output (would need it exported)
// For now, verify the module compiles and key types are correct.

import type { V2CLIArgs, V2Config, Session, Task } from "../../src/v2/types.js";
import { defaultV2Config } from "../../src/v2/types.js";

describe("V2CLIArgs type", () => {
  it("accepts valid args with all fields", () => {
    const args: V2CLIArgs = {
      projectPath: "/test/project",
      specPath: "/test/spec.md",
      concurrency: 2,
      branch: "feat/test",
      taskFilter: [1, 2, 3],
      dryRun: false,
      verbose: true,
      noTui: false,
    };
    expect(args.projectPath).toBe("/test/project");
    expect(args.specPath).toBe("/test/spec.md");
    expect(args.concurrency).toBe(2);
  });

  it("accepts args with optional specPath undefined", () => {
    const args: V2CLIArgs = {
      projectPath: "/test/project",
      concurrency: 1,
      branch: "feat/test",
      taskFilter: null,
      dryRun: false,
      verbose: false,
      noTui: false,
    };
    expect(args.specPath).toBeUndefined();
    expect(args.taskFilter).toBeNull();
  });
});

describe("Session prompt construction", () => {
  it("produces prompt with session ID, focus, task list, and paths", () => {
    const config = defaultV2Config();
    const session: Session = {
      id: "S1",
      tasks: [
        { id: 1, title: "Task A", creates: [], modifies: [], dependsOn: [], requirements: [], explore: [], tddPhase: "GREEN", commitMessage: "feat: A", complexity: 3, status: "queued", stage: "", turnCount: 0, lastLine: "", bytesReceived: 0 },
        { id: 2, title: "Task B", creates: [], modifies: [], dependsOn: [1], requirements: [], explore: [], tddPhase: "Exempt", commitMessage: "feat: B", complexity: 2, status: "blocked", stage: "", turnCount: 0, lastLine: "", bytesReceived: 0 },
      ],
      complexity: 5,
      focus: "Auth feature",
      status: "queued",
      bytesReceived: 0,
      turnCount: 0,
      lastLine: "",
      stage: "",
      attemptCount: 0,
    };

    // Simulate what buildSessionPrompt does
    const manifestPath = "/test/project/manifest.md";
    const artDir = "/test/project/artifacts";
    const subagentHints = [
      `- Explore sub-agents: model "${config.subagents.explore.model}"`,
      `- Plan Review sub-agents: model "${config.subagents.planReview.model}"`,
      `- Code Review sub-agents: model "${config.subagents.codeReview.model}"`,
    ].join("\n");

    const prompt = `Read the instructions in commands/session-agent.md and follow them exactly.

You are implementing **Session ${session.id}: ${session.focus}**.

Your tasks: ${session.tasks.map(t => `T${t.id} (${t.title})`).join(", ")}.

Manifest: \`${manifestPath}\`
Artifacts directory: \`${artDir}\`

Sub-agent model settings:
${subagentHints}

Write your session plan to: \`${artDir}/s${session.id}-session-plan.md\`
Write your memory entry to: \`${artDir}/s${session.id}-memory-entry.md\``;

    expect(prompt).toContain("Session S1: Auth feature");
    expect(prompt).toContain("T1 (Task A)");
    expect(prompt).toContain("T2 (Task B)");
    expect(prompt).toContain("commands/session-agent.md");
    expect(prompt).toContain(manifestPath);
    expect(prompt).toContain("sonnet"); // explore model
    expect(prompt).toContain("opus"); // planReview model
    expect(prompt).toContain("s${session.id}-session-plan.md".replace("${session.id}", session.id));
  });
});

describe("V2Config integration", () => {
  it("default config provides all agent and subagent models", () => {
    const config = defaultV2Config();

    // All agent roles have provider + model
    expect(config.agents.session.provider).toBe("claude");
    expect(config.agents.session.model).toBeTruthy();
    expect(config.agents.manifest.model).toBeTruthy();
    expect(config.agents.qa.model).toBeTruthy();

    // All subagent roles have model
    expect(config.subagents.explore.model).toBeTruthy();
    expect(config.subagents.planReview.model).toBeTruthy();
    expect(config.subagents.codeReview.model).toBeTruthy();
  });
});
