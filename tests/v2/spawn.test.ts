import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Session } from "../../src/v2/types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import * as fs from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { spawnSession, getRecentOutput } from "../../src/v2/spawn.js";

const mockSpawn = vi.mocked(cpSpawn);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockCreateWriteStream = vi.mocked(fs.createWriteStream);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    tasks: [],
    complexity: 1,
    focus: `Session ${partial.id}`,
    status: "running",
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
    ...partial,
  };
}

function makeMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = vi.fn(() => true);
  child.pid = 12345;
  return child;
}

/** Builds a stream-json line for an assistant message with text content. */
function assistantLine(id: string, text: string, stopReason?: string): string {
  const msg: Record<string, unknown> = {
    id,
    content: [{ type: "text", text }],
  };
  if (stopReason) msg.stop_reason = stopReason;
  return JSON.stringify({ type: "assistant", message: msg });
}

/** Builds a stream-json line for a tool_use content block. */
function toolUseLine(id: string, toolName: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { id, content: [{ type: "tool_use", name: toolName }] },
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let logStreamWrite: ReturnType<typeof vi.fn>;
let logStreamEnd: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  logStreamWrite = vi.fn();
  logStreamEnd = vi.fn();
  mockCreateWriteStream.mockReturnValue({
    write: logStreamWrite,
    end: logStreamEnd,
  } as unknown as fs.WriteStream);
});

function setupSpawn(): { session: Session; child: ChildProcess } {
  const session = makeSession({ id: "s1" });
  const child = makeMockChild();
  mockSpawn.mockReturnValue(child as ReturnType<typeof cpSpawn>);
  return { session, child };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("spawnSession", () => {
  // ── Spawn args construction ───────────────────────────────────────────

  describe("spawn args construction", () => {
    it("passes correct CLI flags to spawn", () => {
      const { child } = setupSpawn();
      const session = makeSession({ id: "s1" });

      spawnSession(session, "do stuff", "claude-opus-4-6", "/tmp/wp", "/proj/logs", false);

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        [
          "-p", "do stuff",
          "--dangerously-skip-permissions",
          "--output-format", "stream-json",
          "--verbose",
          "--model", "claude-opus-4-6",
          "--disable-slash-commands",
        ],
        expect.objectContaining({
          cwd: "/tmp/wp",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

      child.emit("close");
    });

    it("strips CLAUDECODE from env to prevent recursive invocation", () => {
      const { child } = setupSpawn();
      const session = makeSession({ id: "s1" });

      // Set CLAUDECODE in process.env temporarily
      const origVal = process.env.CLAUDECODE;
      process.env.CLAUDECODE = "1";

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const callEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string | undefined>;
      expect(callEnv.CLAUDECODE).toBeUndefined();

      // Restore
      if (origVal === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = origVal;

      child.emit("close");
    });

    it("merges extra env vars into spawn env", () => {
      const { child } = setupSpawn();
      const session = makeSession({ id: "s1" });

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false, {
        ANTHROPIC_BASE_URL: "http://localhost:11434",
      });

      const callEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string | undefined>;
      expect(callEnv.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");

      child.emit("close");
    });

    it("strips CLAUDECODE even if passed in extra env", () => {
      const { child } = setupSpawn();
      const session = makeSession({ id: "s1" });

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false, {
        CLAUDECODE: "sneaky",
      });

      const callEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string | undefined>;
      expect(callEnv.CLAUDECODE).toBeUndefined();

      child.emit("close");
    });
  });

  // ── Log file setup ────────────────────────────────────────────────────

  describe("log file setup", () => {
    it("creates log directory if missing", () => {
      const { child } = setupSpawn();
      const session = makeSession({ id: "s1" });
      mockExistsSync.mockReturnValue(false);

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      expect(mockMkdirSync).toHaveBeenCalledWith("/proj/logs", { recursive: true });

      child.emit("close");
    });

    it("sets session.logPath", () => {
      const { child } = setupSpawn();
      const session = makeSession({ id: "s7" });

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      expect(session.logPath).toBe("/proj/logs/s7.jsonl");

      child.emit("close");
    });

    it("writes raw stdout to log file", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const chunk = Buffer.from("raw data");
      child.stdout!.emit("data", chunk);

      expect(logStreamWrite).toHaveBeenCalledWith(chunk);

      child.emit("close");
    });

    it("closes log stream on child close", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
      child.emit("close");

      expect(logStreamEnd).toHaveBeenCalled();
    });

    it("writes stderr to log with [stderr] prefix", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
      child.stderr!.emit("data", Buffer.from("some error\n"));

      expect(logStreamWrite).toHaveBeenCalledWith("[stderr] some error\n");

      child.emit("close");
    });
  });

  // ── Stream parsing / stage markers ────────────────────────────────────

  describe("stream parsing — stage markers", () => {
    it("sets session.stage from [STAGE: X] in text_delta", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const line = assistantLine("msg-1", "[STAGE: Exploring]\n");
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.stage).toBe("Exploring");

      child.emit("close");
    });

    it("ignores invalid stage marker values", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const line = assistantLine("msg-1", "[STAGE: InvalidPhase]\n");
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.stage).toBe("");

      child.emit("close");
    });

    it("strips stage markers from lastLine", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const line = assistantLine("msg-1", "[STAGE: Planning] Starting plan work\n");
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.stage).toBe("Planning");
      expect(session.lastLine).toBe("Starting plan work");
      expect(session.lastLine).not.toContain("[STAGE:");

      child.emit("close");
    });

    it("uses the last stage marker when text has multiple markers", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const line = assistantLine("msg-1", "[STAGE: Exploring]\nreading files...\n[STAGE: Planning]\nwriting plan...\n");
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.stage).toBe("Planning");
      expect(session.lastLine).toBe("writing plan...");

      child.emit("close");
    });

    it("strips markdown characters from text_delta for lastLine", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const line = assistantLine("msg-1", "## **Hello** `world` _foo_ ~bar~\n");
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.lastLine).toBe("Hello world foo bar");

      child.emit("close");
    });

    it("truncates lastLine to 120 characters", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const longText = "A".repeat(150) + "\n";
      const line = assistantLine("msg-1", longText);
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.lastLine.length).toBe(120);

      child.emit("close");
    });

    it("sets lastLine to [using toolName] on tool_use_start", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      const line = toolUseLine("msg-1", "Read");
      child.stdout!.emit("data", Buffer.from(line + "\n"));

      expect(session.lastLine).toBe("[using Read]");

      child.emit("close");
    });
  });

  // ── Dashboard metrics ─────────────────────────────────────────────────

  describe("dashboard metrics", () => {
    it("accumulates bytesReceived from chunks", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      child.stdout!.emit("data", Buffer.from("hello")); // 5
      child.stdout!.emit("data", Buffer.from("world!!")); // 7

      expect(session.bytesReceived).toBe(12);

      child.emit("close");
    });

    it("increments turnCount on message_start (new message ID)", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      // Two assistant messages with different IDs
      const line1 = assistantLine("msg-1", "Hello\n");
      const line2 = assistantLine("msg-2", "World\n");
      child.stdout!.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));

      expect(session.turnCount).toBe(2);

      child.emit("close");
    });

    it("does not increment turnCount for same message ID", () => {
      const { session, child } = setupSpawn();

      spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

      // Same message ID in two chunks (accumulated text pattern)
      const line1 = assistantLine("msg-1", "Hello\n");
      const line2 = assistantLine("msg-1", "Hello World\n");
      child.stdout!.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));

      expect(session.turnCount).toBe(1);

      child.emit("close");
    });
  });

  // ── Returns the child process ─────────────────────────────────────────

  it("returns the ChildProcess from spawn", () => {
    const { session, child } = setupSpawn();

    const result = spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

    expect(result).toBe(child);

    child.emit("close");
  });
});

// ─── Stall detection ────────────────────────────────────────────────────────

describe("stall detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills process after startup timeout (2 min) with zero bytes", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

    vi.advanceTimersByTime(2 * 60 * 1000 + 15 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.lastLine).toContain("[STALL]");
    expect(session.lastLine).toContain("startup timeout");

    child.emit("close");
  });

  it("kills process after mid-task stall (5 min) with no new bytes", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

    child.stdout!.emit("data", Buffer.from("initial output"));
    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.lastLine).toContain("[STALL]");
    expect(session.lastLine).toContain("mid-task timeout");

    child.emit("close");
  });

  it("does not kill process if bytes keep flowing", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

    for (let i = 0; i < 36; i++) {
      vi.advanceTimersByTime(10 * 1000);
      child.stdout!.emit("data", Buffer.from("more data"));
    }

    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close");
  });

  it("clears stall interval on child close", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
    child.emit("close");

    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(child.kill).not.toHaveBeenCalled();
  });
});

// ─── Ring buffer ────────────────────────────────────────────────────────────

describe("ring buffer", () => {
  it("getRecentOutput returns empty array for unknown session", () => {
    const result = getRecentOutput(makeSession({ id: "unknown" }));
    expect(result).toEqual([]);
  });

  it("stores stdout lines", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
    child.stdout!.emit("data", Buffer.from("line1\nline2\nline3\n"));

    expect(getRecentOutput(session)).toEqual(["line1", "line2", "line3"]);

    child.emit("close");
  });

  it("stores stderr lines with [stderr] prefix", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
    child.stderr!.emit("data", Buffer.from("error msg\n"));

    expect(getRecentOutput(session)).toEqual(["[stderr] error msg"]);

    child.emit("close");
  });

  it("keeps only last 30 lines", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);

    const lines = Array.from({ length: 35 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    child.stdout!.emit("data", Buffer.from(lines));

    const result = getRecentOutput(session);
    expect(result).toHaveLength(30);
    expect(result[0]).toBe("line6");
    expect(result[29]).toBe("line35");

    child.emit("close");
  });

  it("is cleaned up on process close", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
    child.stdout!.emit("data", Buffer.from("output\n"));
    child.emit("close");

    expect(getRecentOutput(session)).toEqual([]);
  });

  it("returns a copy, not a reference to internal buffer", () => {
    const { session, child } = setupSpawn();

    spawnSession(session, "brief", "sonnet", "/tmp/wp", "/proj/logs", false);
    child.stdout!.emit("data", Buffer.from("line1\n"));

    const snapshot = getRecentOutput(session);
    snapshot.push("tampered");

    expect(getRecentOutput(session)).toEqual(["line1"]);

    child.emit("close");
  });
});
