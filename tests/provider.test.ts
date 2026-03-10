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

  // ── 5-11. parseStream ────────────────────────────────────────────────────

  describe("parseStream", () => {
    it("parses newline-delimited JSON correctly", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      });
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("handles message_start → { type: 'message_start', turnIndex }", () => {
      const line = JSON.stringify({
        type: "message_start",
        message: { turn_index: 3 },
      });
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({
        type: "message_start",
        turnIndex: 3,
      });
    });

    it("handles content_block_delta with text_delta → { type: 'text_delta', text }", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "world" },
      });
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({
        type: "text_delta",
        text: "world",
      });
    });

    it("handles content_block_start with tool_use → { type: 'tool_use_start', toolName }", () => {
      const line = JSON.stringify({
        type: "content_block_start",
        content_block: { type: "tool_use", name: "read_file" },
      });
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({
        type: "tool_use_start",
        toolName: "read_file",
      });
    });

    it("handles message completion → { type: 'message_end' }", () => {
      const line = JSON.stringify({ type: "message_stop" });
      const chunk = Buffer.from(line + "\n");
      const events = provider.parseStream(chunk);
      expect(events).toContainEqual({ type: "message_end" });
    });

    it("buffers partial lines across chunks", () => {
      const fullLine = JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "buffered" },
      });

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
      const lines = [
        JSON.stringify({
          type: "message_start",
          message: { turn_index: 0 },
        }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        }),
      ].join("\n") + "\n";

      const events = provider.parseStream(Buffer.from(lines));
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "message_start", turnIndex: 0 });
      expect(events[1]).toEqual({ type: "text_delta", text: "hi" });
    });
  });

  // ── createStreamParser ─────────────────────────────────────────────────

  describe("createStreamParser", () => {
    it("returns independent parsers that do not share buffer state", () => {
      const parser1 = provider.createStreamParser();
      const parser2 = provider.createStreamParser();

      const line1 = JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "from-parser-1" },
      });
      const line2 = JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "from-parser-2" },
      });

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
      const fullLine = JSON.stringify({
        type: "message_start",
        message: { turn_index: 5 },
      });

      const part1 = fullLine.slice(0, 10);
      const part2 = fullLine.slice(10) + "\n";

      expect(parser(Buffer.from(part1))).toEqual([]);
      expect(parser(Buffer.from(part2))).toContainEqual({
        type: "message_start",
        turnIndex: 5,
      });
    });
  });

  // ── 12-13. healthCheck ───────────────────────────────────────────────────

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

// ── 14-15. createProvider factory ──────────────────────────────────────────

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
