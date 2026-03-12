import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Provider, SpawnOpts, StreamEvent, StreamParser } from "./types.js";

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
    ];

    // Clone env and strip CLAUDECODE to prevent recursive invocation
    const env = { ...process.env };
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

  // Claude-specific: maps full model IDs to Agent tool shorthand.
  // Future providers (OpenAI, Ollama) will implement their own version.
  subagentModelHint(fullModel: string, _providerName: string): string {
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
