import { describe, it, expect } from "vitest";
import { defaultModelConfig } from "../src/types.js";

describe("defaultModelConfig", () => {
  it("returns an object with exactly 3 agent roles", () => {
    const config = defaultModelConfig();
    const keys = Object.keys(config);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("architect");
    expect(keys).toContain("implementation");
    expect(keys).toContain("qa");
  });

  it("returns a fresh object on each call (no shared references)", () => {
    const a = defaultModelConfig();
    const b = defaultModelConfig();
    expect(a).not.toBe(b);
    expect(a.architect).not.toBe(b.architect);
    expect(a.architect.subagents).not.toBe(b.architect.subagents);
  });

  describe("architect agent", () => {
    it('has provider "claude"', () => {
      const config = defaultModelConfig();
      expect(config.architect.provider).toBe("claude");
    });

    it('has model "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.architect.model).toBe("claude-opus-4-6");
    });

    it("has exactly 2 subagents: explore and planReview", () => {
      const config = defaultModelConfig();
      const subKeys = Object.keys(config.architect.subagents);
      expect(subKeys).toHaveLength(2);
      expect(subKeys).toContain("explore");
      expect(subKeys).toContain("planReview");
    });

    it('explore subagent uses "claude-sonnet-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.architect.subagents.explore.model).toBe("claude-sonnet-4-6");
    });

    it('planReview subagent uses "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.architect.subagents.planReview.model).toBe("claude-opus-4-6");
    });
  });

  describe("implementation agent", () => {
    it('has provider "claude"', () => {
      const config = defaultModelConfig();
      expect(config.implementation.provider).toBe("claude");
    });

    it('has model "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.implementation.model).toBe("claude-opus-4-6");
    });

    it("has exactly 1 subagent: codeReview", () => {
      const config = defaultModelConfig();
      const subKeys = Object.keys(config.implementation.subagents);
      expect(subKeys).toHaveLength(1);
      expect(subKeys).toContain("codeReview");
    });

    it('codeReview subagent uses "claude-sonnet-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.implementation.subagents.codeReview.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("qa agent", () => {
    it('has provider "claude"', () => {
      const config = defaultModelConfig();
      expect(config.qa.provider).toBe("claude");
    });

    it('has model "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.qa.model).toBe("claude-opus-4-6");
    });

    it("has exactly 1 subagent: qaFixer", () => {
      const config = defaultModelConfig();
      const subKeys = Object.keys(config.qa.subagents);
      expect(subKeys).toHaveLength(1);
      expect(subKeys).toContain("qaFixer");
    });

    it('qaFixer subagent uses "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.qa.subagents.qaFixer.model).toBe("claude-opus-4-6");
    });
  });

  it("all agent roles use provider claude", () => {
    const config = defaultModelConfig();
    expect(config.architect.provider).toBe("claude");
    expect(config.implementation.provider).toBe("claude");
    expect(config.qa.provider).toBe("claude");
  });
});
