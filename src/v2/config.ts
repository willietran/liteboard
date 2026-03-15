import * as fs from "node:fs";
import * as path from "node:path";
import type { V2Config, AgentConfig, SubagentConfig } from "./types.js";
import { defaultV2Config } from "./types.js";

/**
 * Reads config.json from projectDir, deep-merges with defaults, returns validated config.
 * Returns defaults when config.json is missing. Throws on malformed JSON.
 */
export function parseV2Config(projectDir: string): V2Config {
  const configPath = path.join(projectDir, "config.json");
  const defaults = defaultV2Config();

  if (!fs.existsSync(configPath)) return defaults;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8") as string);
  } catch {
    throw new Error(`Failed to parse ${configPath}: invalid JSON`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Failed to parse ${configPath}: expected a JSON object`);
  }

  const obj = raw as Record<string, unknown>;

  // Top-level scalar fields
  if (typeof obj.concurrency === "number") defaults.concurrency = obj.concurrency;
  if (typeof obj.branch === "string") defaults.branch = obj.branch;

  // Deep-merge agents
  if (obj.agents && typeof obj.agents === "object" && !Array.isArray(obj.agents)) {
    const agents = obj.agents as Record<string, Record<string, unknown>>;
    for (const role of ["session", "manifest", "qa"] as const) {
      if (!agents[role] || typeof agents[role] !== "object") continue;
      const src = agents[role];
      if (typeof src.provider === "string") defaults.agents[role].provider = src.provider;
      if (typeof src.model === "string") defaults.agents[role].model = src.model;
    }
  }

  // Deep-merge subagents
  if (obj.subagents && typeof obj.subagents === "object" && !Array.isArray(obj.subagents)) {
    const subagents = obj.subagents as Record<string, Record<string, unknown>>;
    for (const role of ["explore", "planReview", "codeReview"] as const) {
      if (!subagents[role] || typeof subagents[role] !== "object") continue;
      const src = subagents[role];
      if (typeof src.model === "string") defaults.subagents[role].model = src.model;
    }
  }

  return defaults;
}
