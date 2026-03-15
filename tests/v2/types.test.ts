import { describe, it, expect } from "vitest";
import { VALID_STAGE_MARKERS, defaultV2Config } from "../../src/v2/types.js";

describe("VALID_STAGE_MARKERS", () => {
  it("contains expected stage markers", () => {
    expect(VALID_STAGE_MARKERS.has("Exploring")).toBe(true);
    expect(VALID_STAGE_MARKERS.has("Planning")).toBe(true);
    expect(VALID_STAGE_MARKERS.has("Plan Review")).toBe(true);
    expect(VALID_STAGE_MARKERS.has("Implementing")).toBe(true);
    expect(VALID_STAGE_MARKERS.has("Verifying")).toBe(true);
    expect(VALID_STAGE_MARKERS.has("Code Review")).toBe(true);
    expect(VALID_STAGE_MARKERS.has("Committing")).toBe(true);
  });

  it("excludes Merging (set by orchestrator, not agent)", () => {
    expect(VALID_STAGE_MARKERS.has("Merging")).toBe(false);
  });

  it("rejects unknown stages", () => {
    expect(VALID_STAGE_MARKERS.has("Unknown")).toBe(false);
    expect(VALID_STAGE_MARKERS.has("")).toBe(false);
  });
});

describe("defaultV2Config", () => {
  it("returns Opus for session and manifest agents", () => {
    const config = defaultV2Config();
    expect(config.agents.session.model).toBe("claude-opus-4-6");
    expect(config.agents.manifest.model).toBe("claude-opus-4-6");
  });

  it("returns Sonnet for QA agent", () => {
    const config = defaultV2Config();
    expect(config.agents.qa.model).toBe("claude-sonnet-4-6");
  });

  it("returns correct subagent models", () => {
    const config = defaultV2Config();
    expect(config.subagents.explore.model).toBe("sonnet");
    expect(config.subagents.planReview.model).toBe("opus");
    expect(config.subagents.codeReview.model).toBe("sonnet");
  });

  it("defaults to concurrency 1", () => {
    const config = defaultV2Config();
    expect(config.concurrency).toBe(1);
  });

  it("uses claude provider for all agents", () => {
    const config = defaultV2Config();
    expect(config.agents.session.provider).toBe("claude");
    expect(config.agents.manifest.provider).toBe("claude");
    expect(config.agents.qa.provider).toBe("claude");
  });
});
