import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Provider, SpawnOpts, StreamEvent, StreamParser, OllamaConfig } from "./types.js";

// ─── Claude Code Provider ──────────────────────────────────────────────────

export class ClaudeCodeProvider implements Provider {
  readonly name = "claude";

  spawn(opts: SpawnOpts): ChildProcess {
    const args = [
      "-p",
      opts.prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      opts.model,
      "--disable-slash-commands",
    ];

    // Clone env and strip CLAUDECODE to prevent recursive invocation
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // Inject provider-specific env vars (e.g., Ollama base URL)
    if (opts.env) {
      Object.assign(env, opts.env);
    }

    // Defense-in-depth: ensure CLAUDECODE is never re-inserted via opts.env
    delete env.CLAUDECODE;

    return spawn("claude", args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Creates an independent stream parser with its own buffer. */
  createStreamParser(): StreamParser {
    let buffer = "";
    let lastMessageId = "";
    return (chunk: Buffer): StreamEvent[] => {
      const events: StreamEvent[] = [];

      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");

      // Last element is either an incomplete line or empty string after trailing \n
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // Malformed JSON — skip silently
          continue;
        }

        const mapped = this.mapEvent(parsed, lastMessageId);
        const msgId = this.extractMessageId(parsed);
        if (msgId) lastMessageId = msgId;
        events.push(...mapped);
      }

      return events;
    };
  }

  /** Convenience single-use parser (uses an internal single-shot parser). */
  parseStream(chunk: Buffer): StreamEvent[] {
    if (!this._singleParser) {
      this._singleParser = this.createStreamParser();
    }
    return this._singleParser(chunk);
  }

  private _singleParser?: StreamParser;

  // Maps full model IDs to Agent tool shorthand.
  // Claude: opus/sonnet/haiku. Ollama: empty (subagents inherit parent model).
  subagentModelHint(fullModel: string, providerName: string): string {
    if (providerName !== "claude") return "";
    if (fullModel.includes("opus")) return "opus";
    if (fullModel.includes("haiku")) return "haiku";
    return "sonnet";
  }

  async healthCheck(): Promise<boolean> {
    try {
      execFileSync("which", ["claude"]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Maps a Claude Code stream-json envelope to StreamEvent(s).
   *
   * Claude Code's `--output-format stream-json` emits envelopes like:
   *   { type: "assistant", message: { id, content: [...], stop_reason } }
   *   { type: "user", message: { content: [{ type: "tool_result", ... }] } }
   *   { type: "system" | "result" | "rate_limit_event" }
   *   { type: "error", error: { message } }
   */
  private mapEvent(
    raw: Record<string, unknown>,
    lastMessageId: string,
  ): StreamEvent[] {
    switch (raw.type) {
      case "assistant": {
        const message = raw.message as
          | {
              id?: string;
              content?: Array<{ type: string; text?: string; name?: string }>;
              stop_reason?: string | null;
            }
          | undefined;
        if (!message) return [];

        const events: StreamEvent[] = [];

        // New turn when message ID changes
        const msgId = this.extractMessageId(raw);
        if (msgId && msgId !== lastMessageId) {
          events.push({ type: "message_start", turnIndex: 0 });
        }

        // Emit events for each content block
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "text" && block.text !== undefined) {
              events.push({ type: "text_delta", text: block.text });
            } else if (block.type === "tool_use" && block.name) {
              events.push({ type: "tool_use_start", toolName: block.name });
            }
          }
        }

        // Message complete when stop_reason is set
        if (message.stop_reason) {
          events.push({ type: "message_end" });
        }

        return events;
      }

      case "user": {
        return [{ type: "tool_use_end" }];
      }

      case "error": {
        const error = raw.error as { message?: string } | undefined;
        return [
          {
            type: "error",
            message: error?.message ?? "Unknown error",
          },
        ];
      }

      // system, rate_limit_event, result, unknown — skip
      default:
        return [];
    }
  }

  /** Extracts message ID from an assistant envelope, or undefined. */
  private extractMessageId(
    raw: Record<string, unknown>,
  ): string | undefined {
    if (raw.type !== "assistant") return undefined;
    const message = raw.message as { id?: string } | undefined;
    return message?.id;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createProvider(name: string): Provider {
  switch (name) {
    case "claude":
      return new ClaudeCodeProvider();
    default:
      throw new Error(`Unknown provider: "${name}"`);
  }
}

// ─── Ollama Helpers ─────────────────────────────────────────────────────────

/** Returns provider-specific env vars for agent spawning, or undefined for Claude. */
export function getProviderEnv(
  providerName: string,
  ollamaConfig?: OllamaConfig,
): Record<string, string> | undefined {
  if (providerName === "ollama") {
    const baseUrl = ollamaConfig?.baseUrl ?? "http://localhost:11434";
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
    };
  }
  return undefined;
}

/** Checks if Ollama is reachable at the given base URL. */
export async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const normalized = baseUrl.replace(/\/$/, "");
    const response = await fetch(`${normalized}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Checks if a specific model is registered in Ollama via /api/show. */
export async function checkOllamaModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    const normalized = baseUrl.replace(/\/$/, "");
    const response = await fetch(`${normalized}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Pulls an Ollama model. Returns true on success, false on failure/timeout. */
export function pullOllamaModel(model: string): boolean {
  try {
    execFileSync("ollama", ["pull", model], { stdio: "pipe", timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

/** Validates that an Ollama base URL is a valid http or https URL. Throws on invalid. */
export function validateOllamaBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid ollama.baseUrl: must be an http:// or https:// URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid ollama.baseUrl: must be an http:// or https:// URL");
  }
}
