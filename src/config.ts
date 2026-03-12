import * as fs from "node:fs";
import type { ProjectConfig, ModelConfig } from "./types.js";
import { defaultModelConfig } from "./types.js";

// Logs to stderr — consistent with other modules (parser.ts, merger.ts, etc.).
function log(msg: string): void {
  console.error(msg);
}

const VALID_PROVIDERS = new Set(["claude", "ollama"]);

/** Fallback model for subagents not present in defaults. */
const DEFAULT_SUBAGENT_MODEL = "claude-sonnet-4-6";

/** Derive required subagents from defaults — single source of truth. */
const REQUIRED_SUBAGENTS: Record<string, string[]> = Object.fromEntries(
  Object.entries(defaultModelConfig()).map(([role, agent]) => [role, Object.keys(agent.subagents)]),
);

// ─── parseProjectConfig ──────────────────────────────────────────────────────

/**
 * Reads and parses a config.json file, deep-merging with defaults.
 * Returns defaults if file is missing, invalid, or uses the old flat format.
 *
 * Merge priority: defaults ← config.json (CLI overrides happen in cli.ts, not here).
 */
export function parseProjectConfig(configPath: string): ProjectConfig {
  const defaults = defaultModelConfig();
  const result: ProjectConfig = { agents: defaults, concurrency: 1 };

  if (!fs.existsSync(configPath)) return result;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8") as string);
  } catch {
    log("\x1b[33mWarning: Could not parse config.json\x1b[0m");
    return result;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log("\x1b[33mWarning: config.json is not a JSON object. Using defaults.\x1b[0m");
    return result;
  }

  const obj = raw as Record<string, unknown>;

  // Old format deprecation — skip agent merge but still extract other fields
  if ("models" in obj) {
    log("\x1b[33mWarning: config.json uses deprecated flat 'models' key. Ignoring — using defaults. Update to the new 'agents' format.\x1b[0m");
  }

  // Extract non-agent fields regardless of format
  if (typeof obj.concurrency === "number") result.concurrency = obj.concurrency;
  if (typeof obj.branch === "string") result.branch = obj.branch;
  if (obj.ollama && typeof obj.ollama === "object") {
    result.ollama = obj.ollama as ProjectConfig["ollama"];
  }

  // Deep merge agents (only for new format, skip if old "models" key present)
  if (!("models" in obj) && obj.agents && typeof obj.agents === "object") {
    const agents = obj.agents as Record<string, Record<string, unknown>>;
    for (const role of ["architect", "implementation", "qa"] as const) {
      if (!agents[role]) continue;
      const src = agents[role];
      if (typeof src.provider === "string") result.agents[role].provider = src.provider;
      if (typeof src.model === "string") result.agents[role].model = src.model;
      if (src.subagents && typeof src.subagents === "object") {
        for (const [subName, subCfg] of Object.entries(src.subagents as Record<string, unknown>)) {
          if (subCfg && typeof subCfg === "object" && "model" in subCfg) {
            result.agents[role].subagents[subName] = { model: (subCfg as { model: string }).model };
          }
        }
      }
    }
  }

  return result;
}

// ─── validateConfig ──────────────────────────────────────────────────────────

/** Validates a ProjectConfig. Throws on invalid combinations. */
export function validateConfig(config: ProjectConfig): void {
  for (const [role, agent] of Object.entries(config.agents)) {
    if (!VALID_PROVIDERS.has(agent.provider)) {
      throw new Error(`Unknown provider '${agent.provider}'. Supported: claude, ollama.`);
    }
    if (agent.provider === "ollama" && !config.ollama) {
      throw new Error(`Agent '${role}' uses provider 'ollama' but no 'ollama' config section found.`);
    }
    const required = REQUIRED_SUBAGENTS[role];
    if (required) {
      for (const subName of required) {
        if (!agent.subagents[subName]) {
          throw new Error(`Agent '${role}' is missing required subagent '${subName}'.`);
        }
      }
    }
  }
}

// ─── applyOllamaFallback ────────────────────────────────────────────────────

/** Rewrites all Ollama agent slots to Claude defaults when Ollama is unreachable. */
export function applyOllamaFallback(config: ProjectConfig): void {
  const defaults = defaultModelConfig();
  for (const [role, agent] of Object.entries(config.agents)) {
    if (agent.provider === "ollama") {
      log(`\x1b[33mWarning: Ollama unreachable. Falling back to Claude for ${role}.\x1b[0m`);
      const defaultAgent = defaults[role as keyof ModelConfig];
      agent.provider = "claude";
      agent.model = defaultAgent.model;
      for (const subName of Object.keys(agent.subagents)) {
        agent.subagents[subName].model = defaultAgent.subagents[subName]?.model ?? DEFAULT_SUBAGENT_MODEL;
      }
    }
  }
}

// ─── hasOllamaProvider ───────────────────────────────────────────────────────

/** Returns true if any agent role uses the "ollama" provider. */
export function hasOllamaProvider(config: ProjectConfig): boolean {
  return Object.values(config.agents).some(agent => agent.provider === "ollama");
}
