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

        const event = this.mapEvent(parsed);
        if (event) {
          events.push(event);
        }
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

  async healthCheck(): Promise<boolean> {
    try {
      execFileSync("which", ["claude"]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private mapEvent(raw: Record<string, unknown>): StreamEvent | null {
    switch (raw.type) {
      case "message_start": {
        const message = raw.message as
          | { turn_index?: number }
          | undefined;
        return {
          type: "message_start",
          turnIndex: message?.turn_index ?? 0,
        };
      }

      case "content_block_delta": {
        const delta = raw.delta as
          | { type?: string; text?: string }
          | undefined;
        if (delta?.type === "text_delta" && delta.text !== undefined) {
          return { type: "text_delta", text: delta.text };
        }
        return null;
      }

      case "content_block_start": {
        const block = raw.content_block as
          | { type?: string; name?: string }
          | undefined;
        if (block?.type === "tool_use" && block.name) {
          return { type: "tool_use_start", toolName: block.name };
        }
        return null;
      }

      case "content_block_stop": {
        return { type: "tool_use_end" };
      }

      case "message_stop": {
        return { type: "message_end" };
      }

      case "error": {
        const error = raw.error as { message?: string } | undefined;
        return {
          type: "error",
          message: error?.message ?? "Unknown error",
        };
      }

      default:
        return null;
    }
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
