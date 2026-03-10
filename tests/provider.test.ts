import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { SpawnOpts, StreamEvent } from "../src/types.js";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import { spawn, execFileSync } from "node:child_process";
import { ClaudeCodeProvider, createProvider } from "../src/provider.js";

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Claude Code assistant envelope. */
function assistantEvent(
  id: string,
  content: Array<{ type: string; text?: string; name?: string }>,
  stopReason?: string | null,
) {
  return {
    type: "assistant",
    message: {
      id,
      content,
      stop_reason: stopReason ?? null,
    },
  };
}

/** Build a Claude Code user envelope (tool results). */
function userEvent() {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
    },
  };
}

describe("ClaudeCodeProvider", () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    provider = new ClaudeCodeProvider();
    vi.clearAllMocks();
  });

  // ── 1. name ──────────────────────────────────────────────────────────────

  it('has name "claude"', () => {
    expect(provider.name).toBe("claude");
  });

  // ── 2-4. spawn ────────────────────────────────────────────────────────────

  describe("spawn", () => {
    const baseOpts: SpawnOpts = {
      prompt: "Write hello world",
      model: "sonnet",
      cwd: "/tmp/project",
      verbose: true,
    };

    const fakeChild = { pid: 1234 } as unknown as ChildProcess;

    beforeEach(() => {
      mockSpawn.mockReturnValue(fakeChild);
    });

    it("spawns claude with the correct arguments", () => {
      provider.spawn(baseOpts);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe("claude");
      expect(args).toEqual([
        "-p",
        "Write hello world",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "sonnet",
      ]);
    });

    it("strips CLAUDECODE env var from the child environment", () => {
      // Seed the current process env
      const originalEnv = process.env.CLAUDECODE;
      process.env.CLAUDECODE = "some-value";

      provider.spawn(baseOpts);

      const spawnOptions = mockSpawn.mock.calls[0][2] as {
        env: Record<string, string | undefined>;
      };
      expect(spawnOptions.env).toBeDefined();
      expect(spawnOptions.env.CLAUDECODE).toBeUndefined();

      // Restore
      if (originalEnv === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalEnv;
      }
    });

    it("uses the provided cwd", () => {
      provider.spawn(baseOpts);

      const spawnOptions = mockSpawn.mock.calls[0][2] as { cwd: string };
      expect(spawnOptions.cwd).toBe("/tmp/project");
    });

    it("returns the ChildProcess from spawn", () => {
      const result = provider.spawn(baseOpts);
      expect(result).toBe(fakeChild);
    });
  });

  // ── parseStream ────────────────────────────────────────────────────────────

  describe("parseStream", () => {
    it("parses newline-delimited JSON correctly", () => {
      const line = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "hello" }]),
      );
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("handles assistant event with new message ID → message_start", () => {
      const line = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "hi" }]),
      );
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({
        type: "message_start",
        turnIndex: 0,
      });
    });

    it("handles assistant event with text content → text_delta", () => {
      const line = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "world" }]),
      );
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({
        type: "text_delta",
        text: "world",
      });
    });

    it("handles assistant event with tool_use content → tool_use_start", () => {
      const line = JSON.stringify(
        assistantEvent("msg_1", [{ type: "tool_use", name: "Read" }]),
      );
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({
        type: "tool_use_start",
        toolName: "Read",
      });
    });

    it("handles assistant event with stop_reason → message_end", () => {
      const line = JSON.stringify(
        assistantEvent("msg_2", [{ type: "text", text: "done" }], "end_turn"),
      );
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({ type: "message_end" });
    });

    it("buffers partial lines across chunks", () => {
      const fullLine = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "buffered" }]),
      );

      // Split in the middle
      const half1 = fullLine.slice(0, 20);
      const half2 = fullLine.slice(20) + "\n";

      const events1 = provider.parseStream(Buffer.from(half1));
      expect(events1).toEqual([]); // No complete line yet

      const events2 = provider.parseStream(Buffer.from(half2));
      expect(events2).toContainEqual({
        type: "text_delta",
        text: "buffered",
      });
    });

    it("handles empty lines gracefully", () => {
      const chunk = Buffer.from("\n\n\n");
      const events = provider.parseStream(chunk);
      // Should not throw; empty lines produce no events
      expect(events).toEqual([]);
    });

    it("handles malformed JSON lines gracefully", () => {
      const chunk = Buffer.from("{not-valid-json}\n");
      const events = provider.parseStream(chunk);
      // Malformed lines are silently skipped
      expect(events).toEqual([]);
    });

    it("handles multiple events in a single chunk", () => {
      const lines =
        [
          JSON.stringify(
            assistantEvent("msg_1", [{ type: "text", text: "first" }]),
          ),
          JSON.stringify(
            assistantEvent("msg_2", [{ type: "text", text: "second" }]),
          ),
        ].join("\n") + "\n";

      const events = provider.parseStream(Buffer.from(lines));
      // Each assistant event with new ID emits message_start + text_delta = 4 total
      expect(events).toHaveLength(4);
      expect(events[0]).toEqual({ type: "message_start", turnIndex: 0 });
      expect(events[1]).toEqual({ type: "text_delta", text: "first" });
      expect(events[2]).toEqual({ type: "message_start", turnIndex: 0 });
      expect(events[3]).toEqual({ type: "text_delta", text: "second" });
    });
  });

  // ── createStreamParser ─────────────────────────────────────────────────

  describe("createStreamParser", () => {
    it("returns independent parsers that do not share buffer state", () => {
      const parser1 = provider.createStreamParser();
      const parser2 = provider.createStreamParser();

      const line1 = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "from-parser-1" }]),
      );
      const line2 = JSON.stringify(
        assistantEvent("msg_2", [{ type: "text", text: "from-parser-2" }]),
      );

      // Send partial line to parser1
      const half1 = line1.slice(0, 15);
      const events1a = parser1(Buffer.from(half1));
      expect(events1a).toEqual([]);

      // Send complete line to parser2 — should not be affected by parser1's buffer
      const events2 = parser2(Buffer.from(line2 + "\n"));
      expect(events2).toContainEqual({
        type: "text_delta",
        text: "from-parser-2",
      });

      // Complete parser1's line
      const events1b = parser1(Buffer.from(line1.slice(15) + "\n"));
      expect(events1b).toContainEqual({
        type: "text_delta",
        text: "from-parser-1",
      });
    });

    it("buffers partial lines correctly within a single parser", () => {
      const parser = provider.createStreamParser();
      const fullLine = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "partial-test" }]),
      );

      const part1 = fullLine.slice(0, 10);
      const part2 = fullLine.slice(10) + "\n";

      expect(parser(Buffer.from(part1))).toEqual([]);
      expect(parser(Buffer.from(part2))).toContainEqual({
        type: "message_start",
        turnIndex: 0,
      });
    });

    it("emits multiple events from single assistant line with mixed content", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify(
        assistantEvent("msg_1", [
          { type: "text", text: "analyzing..." },
          { type: "tool_use", name: "Read" },
        ]),
      );

      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([
        { type: "message_start", turnIndex: 0 },
        { type: "text_delta", text: "analyzing..." },
        { type: "tool_use_start", toolName: "Read" },
      ]);
    });

    it("does not emit message_start for same message ID", () => {
      const parser = provider.createStreamParser();

      // First chunk — new message ID
      const line1 = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "part1" }]),
      );
      const events1 = parser(Buffer.from(line1 + "\n"));
      expect(events1).toContainEqual({ type: "message_start", turnIndex: 0 });

      // Second chunk — same message ID
      const line2 = JSON.stringify(
        assistantEvent("msg_1", [{ type: "text", text: "part2" }]),
      );
      const events2 = parser(Buffer.from(line2 + "\n"));
      expect(events2).not.toContainEqual(
        expect.objectContaining({ type: "message_start" }),
      );
      expect(events2).toContainEqual({ type: "text_delta", text: "part2" });
    });

    it("emits tool_use_end on user event", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify(userEvent());
      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([{ type: "tool_use_end" }]);
    });

    it("skips system events", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess_1",
      });
      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([]);
    });

    it("maps error envelope to error event", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify({
        type: "error",
        error: { message: "rate limited" },
      });
      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([{ type: "error", message: "rate limited" }]);
    });

    it("maps error envelope without message to Unknown error", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify({ type: "error", error: {} });
      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([{ type: "error", message: "Unknown error" }]);
    });

    it("skips rate_limit_event", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify({
        type: "rate_limit_event",
        retry_after: 30,
      });
      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([]);
    });

    it("assistant event with stop_reason tool_use emits tool_use_start and message_end", () => {
      const parser = provider.createStreamParser();
      const line = JSON.stringify(
        assistantEvent(
          "msg_1",
          [{ type: "tool_use", name: "Edit" }],
          "tool_use",
        ),
      );

      const events = parser(Buffer.from(line + "\n"));
      expect(events).toEqual([
        { type: "message_start", turnIndex: 0 },
        { type: "tool_use_start", toolName: "Edit" },
        { type: "message_end" },
      ]);
    });
  });

  // ── healthCheck ───────────────────────────────────────────────────────────

  describe("healthCheck", () => {
    it("returns true when `which claude` succeeds", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/claude\n"));
      const result = await provider.healthCheck();
      expect(result).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith("which", ["claude"]);
    });

    it("returns false when `which claude` fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = await provider.healthCheck();
      expect(result).toBe(false);
    });
  });
});

// ── createProvider factory ──────────────────────────────────────────────────

describe("createProvider", () => {
  it('returns a ClaudeCodeProvider instance for "claude"', () => {
    const p = createProvider("claude");
    expect(p).toBeInstanceOf(ClaudeCodeProvider);
    expect(p.name).toBe("claude");
  });

  it("throws an error for an unknown provider name", () => {
    expect(() => createProvider("unknown-provider")).toThrow(
      /unknown provider/i,
    );
  });
});
