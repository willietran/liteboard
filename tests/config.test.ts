import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectConfig, OllamaConfig } from "../src/types.js";
import { defaultModelConfig } from "../src/types.js";

// Mock node:fs before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import * as fs from "node:fs";
import {
  parseProjectConfig,
  validateConfig,
  applyOllamaFallback,
  hasOllamaProvider,
} from "../src/config.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Returns a valid new-format config JSON string. */
function validConfigJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agents: {
      architect: {
        provider: "claude",
        model: "claude-opus-4-6",
        subagents: {
          explore: { model: "claude-sonnet-4-6" },
          planReview: { model: "claude-opus-4-6" },
        },
      },
      implementation: {
        provider: "claude",
        model: "claude-opus-4-6",
        subagents: {
          codeReview: { model: "claude-sonnet-4-6" },
        },
      },
      qa: {
        provider: "claude",
        model: "claude-opus-4-6",
        subagents: {
          qaFixer: { model: "claude-opus-4-6" },
        },
      },
    },
    concurrency: 2,
    ...overrides,
  });
}

/** Returns a ProjectConfig with all defaults. */
function defaultProjectConfig(): ProjectConfig {
  return { agents: defaultModelConfig(), concurrency: 1 };
}

/** Returns a ProjectConfig with some ollama agents for testing. */
function ollamaProjectConfig(): ProjectConfig {
  const config = defaultProjectConfig();
  config.ollama = { baseUrl: "http://localhost:11434", fallback: true };
  config.agents.implementation.provider = "ollama";
  config.agents.implementation.model = "kimi-k2.5:cloud";
  config.agents.implementation.subagents.codeReview.model = "kimi-k2.5:cloud";
  return config;
}

// ── parseProjectConfig ─────────────────────────────────────────────────────

describe("parseProjectConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns defaults when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = parseProjectConfig("/path/to/config.json");

    expect(result.agents).toEqual(defaultModelConfig());
    expect(result.concurrency).toBe(1);
    expect(result.ollama).toBeUndefined();
  });

  it("parses a valid new-format config.json with agents key", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(validConfigJson({ concurrency: 3 }));

    const result = parseProjectConfig("/path/to/config.json");

    expect(result.agents.architect.provider).toBe("claude");
    expect(result.agents.architect.model).toBe("claude-opus-4-6");
    expect(result.concurrency).toBe(3);
  });

  it("deep-merges: config overrides architect.model but defaults fill the rest", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        architect: { model: "custom-model" },
      },
    }));

    const result = parseProjectConfig("/path/to/config.json");

    expect(result.agents.architect.model).toBe("custom-model");
    // Provider and subagents should come from defaults
    expect(result.agents.architect.provider).toBe("claude");
    expect(result.agents.architect.subagents.explore.model).toBe("claude-sonnet-4-6");
    expect(result.agents.architect.subagents.planReview.model).toBe("claude-opus-4-6");
  });

  it("deep-merges: overrides a single subagent while keeping others at defaults", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        architect: {
          subagents: {
            explore: { model: "custom-explore-model" },
          },
        },
      },
    }));

    const result = parseProjectConfig("/path/to/config.json");

    expect(result.agents.architect.subagents.explore.model).toBe("custom-explore-model");
    expect(result.agents.architect.subagents.planReview.model).toBe("claude-opus-4-6");
  });

  it("loads the ollama section from config", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: { architect: { provider: "ollama", model: "kimi" } },
      ollama: { baseUrl: "http://gpu:11434", fallback: true },
    }));

    const result = parseProjectConfig("/path/to/config.json");

    expect(result.ollama).toEqual({ baseUrl: "http://gpu:11434", fallback: true });
  });

  it("loads branch from config", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      branch: "custom-branch",
    }));

    const result = parseProjectConfig("/path/to/config.json");

    expect(result.branch).toBe("custom-branch");
  });

  describe("old format deprecation", () => {
    it("logs deprecation warning when 'models' key is found", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        models: { implementation: "old-style" },
      }));

      parseProjectConfig("/path/to/config.json");

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("deprecated flat 'models' key"),
      );
    });

    it("skips agent merge for old format but still extracts concurrency/branch/ollama", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        models: { implementation: "old-style" },
        concurrency: 4,
        branch: "old-branch",
        ollama: { baseUrl: "http://old:11434", fallback: false },
      }));

      const result = parseProjectConfig("/path/to/config.json");

      // Agents should be defaults (old format ignored)
      expect(result.agents).toEqual(defaultModelConfig());
      // But concurrency, branch, ollama should still be extracted
      expect(result.concurrency).toBe(4);
      expect(result.branch).toBe("old-branch");
      expect(result.ollama).toEqual({ baseUrl: "http://old:11434", fallback: false });
    });
  });

  describe("edge cases", () => {
    it("returns defaults with warning when config contains invalid JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{ not valid json }");

      const result = parseProjectConfig("/path/to/config.json");

      expect(result.agents).toEqual(defaultModelConfig());
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Could not parse config.json"),
      );
    });

    it("returns defaults when config.json contains null (valid JSON, not an object)", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("null");

      const result = parseProjectConfig("/path/to/config.json");

      expect(result.agents).toEqual(defaultModelConfig());
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("not a JSON object"),
      );
    });

    it("returns defaults when config.json contains an array", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("[1, 2, 3]");

      const result = parseProjectConfig("/path/to/config.json");

      expect(result.agents).toEqual(defaultModelConfig());
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("not a JSON object"),
      );
    });

    it("returns defaults when config is an empty object", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{}");

      const result = parseProjectConfig("/path/to/config.json");

      expect(result.agents).toEqual(defaultModelConfig());
      expect(result.concurrency).toBe(1);
    });

    it("silently ignores unknown top-level keys", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        unknownKey: 42,
        anotherUnknown: "hello",
      }));

      const result = parseProjectConfig("/path/to/config.json");

      expect(result.agents).toEqual(defaultModelConfig());
    });

    it("returns defaults when agents value is not an object", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: "bad",
      }));

      const result = parseProjectConfig("/path/to/config.json");

      expect(result.agents).toEqual(defaultModelConfig());
    });

    it("returns a fresh object on each call (no shared state)", () => {
      mockExistsSync.mockReturnValue(false);

      const a = parseProjectConfig("/path/to/config.json");
      const b = parseProjectConfig("/path/to/config.json");

      expect(a).not.toBe(b);
      expect(a.agents).not.toBe(b.agents);
    });
  });
});

// ── validateConfig ─────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("does not throw for a valid all-claude config", () => {
    const config = defaultProjectConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("does not throw for a valid config with ollama section", () => {
    const config = ollamaProjectConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  describe("unknown provider", () => {
    it("throws for unknown provider name", () => {
      const config = defaultProjectConfig();
      config.agents.architect.provider = "badprovider";

      expect(() => validateConfig(config)).toThrow(
        /Unknown provider 'badprovider'/,
      );
    });

    it("includes 'Supported: claude, ollama' in the error", () => {
      const config = defaultProjectConfig();
      config.agents.qa.provider = "openai";

      expect(() => validateConfig(config)).toThrow(
        /Supported: claude, ollama/,
      );
    });
  });

  describe("ollama without ollama section", () => {
    it("throws when agent uses ollama but no ollama config section exists", () => {
      const config = defaultProjectConfig();
      config.agents.implementation.provider = "ollama";
      // No config.ollama set

      expect(() => validateConfig(config)).toThrow(
        /Agent 'implementation' uses provider 'ollama' but no 'ollama' config section found/,
      );
    });

    it("throws with the correct role name", () => {
      const config = defaultProjectConfig();
      config.agents.architect.provider = "ollama";

      expect(() => validateConfig(config)).toThrow(/Agent 'architect'/);
    });
  });

  describe("missing required subagents", () => {
    it("throws when architect is missing 'explore' subagent", () => {
      const config = defaultProjectConfig();
      delete (config.agents.architect.subagents as Record<string, unknown>).explore;

      expect(() => validateConfig(config)).toThrow(
        /Agent 'architect' is missing required subagent 'explore'/,
      );
    });

    it("throws when architect is missing 'planReview' subagent", () => {
      const config = defaultProjectConfig();
      delete (config.agents.architect.subagents as Record<string, unknown>).planReview;

      expect(() => validateConfig(config)).toThrow(
        /Agent 'architect' is missing required subagent 'planReview'/,
      );
    });

    it("throws when implementation is missing 'codeReview' subagent", () => {
      const config = defaultProjectConfig();
      delete (config.agents.implementation.subagents as Record<string, unknown>).codeReview;

      expect(() => validateConfig(config)).toThrow(
        /Agent 'implementation' is missing required subagent 'codeReview'/,
      );
    });

    it("throws when qa is missing 'qaFixer' subagent", () => {
      const config = defaultProjectConfig();
      delete (config.agents.qa.subagents as Record<string, unknown>).qaFixer;

      expect(() => validateConfig(config)).toThrow(
        /Agent 'qa' is missing required subagent 'qaFixer'/,
      );
    });
  });
});

// ── applyOllamaFallback ────────────────────────────────────────────────────

describe("applyOllamaFallback", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rewrites ollama agent to claude defaults", () => {
    const config = ollamaProjectConfig();

    applyOllamaFallback(config);

    expect(config.agents.implementation.provider).toBe("claude");
    expect(config.agents.implementation.model).toBe("claude-opus-4-6");
    expect(config.agents.implementation.subagents.codeReview.model).toBe("claude-sonnet-4-6");
  });

  it("logs a warning for each affected role", () => {
    const config = ollamaProjectConfig();

    applyOllamaFallback(config);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Falling back to Claude for implementation"),
    );
  });

  it("does not modify agents already using claude", () => {
    const config = ollamaProjectConfig();
    const originalArchitect = { ...config.agents.architect };

    applyOllamaFallback(config);

    expect(config.agents.architect.provider).toBe(originalArchitect.provider);
    expect(config.agents.architect.model).toBe(originalArchitect.model);
  });

  it("handles mixed config: only rewrites ollama agents", () => {
    const config = defaultProjectConfig();
    config.ollama = { baseUrl: "http://localhost:11434", fallback: true };
    config.agents.architect.provider = "ollama";
    config.agents.architect.model = "kimi-k2.5:cloud";
    config.agents.qa.provider = "ollama";
    config.agents.qa.model = "qwen3.5";

    applyOllamaFallback(config);

    // Ollama agents should be rewritten
    expect(config.agents.architect.provider).toBe("claude");
    expect(config.agents.architect.model).toBe("claude-opus-4-6");
    expect(config.agents.qa.provider).toBe("claude");
    expect(config.agents.qa.model).toBe("claude-opus-4-6");
    // Claude agent should be untouched
    expect(config.agents.implementation.provider).toBe("claude");
  });

  it("is a no-op when all agents already use claude (no warnings logged)", () => {
    const config = defaultProjectConfig();

    applyOllamaFallback(config);

    expect(console.error).not.toHaveBeenCalled();
    expect(config.agents).toEqual(defaultModelConfig());
  });

  it("rewrites subagent models to defaults for ollama agents", () => {
    const config = defaultProjectConfig();
    config.ollama = { baseUrl: "http://localhost:11434", fallback: true };
    config.agents.architect.provider = "ollama";
    config.agents.architect.model = "kimi";
    config.agents.architect.subagents.explore.model = "glm-4.7-flash";
    config.agents.architect.subagents.planReview.model = "kimi";

    applyOllamaFallback(config);

    expect(config.agents.architect.subagents.explore.model).toBe("claude-sonnet-4-6");
    expect(config.agents.architect.subagents.planReview.model).toBe("claude-opus-4-6");
  });
});

// ── hasOllamaProvider ──────────────────────────────────────────────────────

describe("hasOllamaProvider", () => {
  it("returns false when all agents use claude", () => {
    const config = defaultProjectConfig();
    expect(hasOllamaProvider(config)).toBe(false);
  });

  it("returns true when any agent uses ollama", () => {
    const config = defaultProjectConfig();
    config.agents.implementation.provider = "ollama";
    expect(hasOllamaProvider(config)).toBe(true);
  });

  it("returns true when all agents use ollama", () => {
    const config = defaultProjectConfig();
    config.agents.architect.provider = "ollama";
    config.agents.implementation.provider = "ollama";
    config.agents.qa.provider = "ollama";
    expect(hasOllamaProvider(config)).toBe(true);
  });
});
