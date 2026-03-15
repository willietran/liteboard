import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultV2Config } from "../../src/v2/types.js";

// Mock node:fs before importing module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import * as fs from "node:fs";
import { parseV2Config } from "../../src/v2/config.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseV2Config", () => {
  it("returns default config when no config.json exists", () => {
    mockExistsSync.mockReturnValue(false);

    const result = parseV2Config("/project");

    expect(result).toEqual(defaultV2Config());
  });

  it("returns a fresh object on each call (no shared state)", () => {
    mockExistsSync.mockReturnValue(false);

    const a = parseV2Config("/project");
    const b = parseV2Config("/project");

    expect(a).not.toBe(b);
    expect(a.agents).not.toBe(b.agents);
  });

  it("partial override — only agents.session.model specified", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        session: { model: "claude-sonnet-4-6" },
      },
    }));

    const result = parseV2Config("/project");

    // Overridden field
    expect(result.agents.session.model).toBe("claude-sonnet-4-6");
    // Defaults preserved
    expect(result.agents.session.provider).toBe("claude");
    expect(result.agents.manifest.model).toBe("claude-opus-4-6");
    expect(result.agents.qa.model).toBe("claude-sonnet-4-6");
    expect(result.subagents).toEqual(defaultV2Config().subagents);
    expect(result.concurrency).toBe(1);
  });

  it("throws on malformed JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{ not valid json }");

    expect(() => parseV2Config("/project")).toThrow(/invalid JSON/);
  });

  it("throws when config.json is not a JSON object (null)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("null");

    expect(() => parseV2Config("/project")).toThrow(/expected a JSON object/);
  });

  it("throws when config.json is an array", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("[1, 2]");

    expect(() => parseV2Config("/project")).toThrow(/expected a JSON object/);
  });

  it("reads concurrency and branch from config", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      concurrency: 4,
      branch: "feat/my-feature",
    }));

    const result = parseV2Config("/project");

    expect(result.concurrency).toBe(4);
    expect(result.branch).toBe("feat/my-feature");
  });

  it("deep-merges subagents correctly", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      subagents: {
        explore: { model: "haiku" },
      },
    }));

    const result = parseV2Config("/project");

    // Overridden
    expect(result.subagents.explore.model).toBe("haiku");
    // Defaults preserved
    expect(result.subagents.planReview.model).toBe("opus");
    expect(result.subagents.codeReview.model).toBe("sonnet");
  });

  it("deep-merges agents and subagents together", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        qa: { provider: "ollama", model: "kimi" },
      },
      subagents: {
        codeReview: { model: "opus" },
      },
      concurrency: 3,
      branch: "fix/bug",
    }));

    const result = parseV2Config("/project");

    expect(result.agents.qa).toEqual({ provider: "ollama", model: "kimi" });
    expect(result.agents.session).toEqual(defaultV2Config().agents.session);
    expect(result.agents.manifest).toEqual(defaultV2Config().agents.manifest);
    expect(result.subagents.codeReview.model).toBe("opus");
    expect(result.subagents.explore.model).toBe("sonnet");
    expect(result.concurrency).toBe(3);
    expect(result.branch).toBe("fix/bug");
  });

  it("ignores unknown top-level keys", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      unknownKey: 42,
    }));

    const result = parseV2Config("/project");

    expect(result.agents).toEqual(defaultV2Config().agents);
    expect(result.concurrency).toBe(1);
  });

  it("ignores unknown agent roles", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        architect: { model: "some-model" },
      },
    }));

    const result = parseV2Config("/project");

    // Only session, manifest, qa exist — architect is ignored
    expect(result.agents).toEqual(defaultV2Config().agents);
  });

  it("handles empty object config gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{}");

    const result = parseV2Config("/project");

    expect(result).toEqual(defaultV2Config());
  });

  it("reads config.json from projectDir path", () => {
    mockExistsSync.mockReturnValue(false);

    parseV2Config("/my/project");

    expect(mockExistsSync).toHaveBeenCalledWith("/my/project/config.json");
  });
});
