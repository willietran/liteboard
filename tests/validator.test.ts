import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
}));

import * as fs from "node:fs";
import { detectProjectType, hashPort, getStartCommand, isPlaywrightMCPAvailable, parseGateResult, processGateLine } from "../src/validator.js";
import type { GateStatus } from "../src/types.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

// ─── detectProjectType ───────────────────────────────────────────────────────

describe("detectProjectType", () => {
  it("detects Next.js from next.config.js", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("next.config.js"),
    );
    expect(detectProjectType("/repo")).toBe("nextjs");
  });

  it("detects Next.js from next.config.mjs", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("next.config.mjs"),
    );
    expect(detectProjectType("/repo")).toBe("nextjs");
  });

  it("detects Next.js from next.config.ts", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("next.config.ts"),
    );
    expect(detectProjectType("/repo")).toBe("nextjs");
  });

  it("detects Vite from vite.config.ts", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("vite.config.ts"),
    );
    expect(detectProjectType("/repo")).toBe("vite");
  });

  it("detects Vite from vite.config.js", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("vite.config.js"),
    );
    expect(detectProjectType("/repo")).toBe("vite");
  });

  it("detects express from dependencies", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    );
    expect(detectProjectType("/repo")).toBe("express");
  });

  it("detects fastify from dependencies", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { fastify: "^4.0.0" } }),
    );
    expect(detectProjectType("/repo")).toBe("express");
  });

  it("detects hono from devDependencies", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ devDependencies: { hono: "^3.0.0" } }),
    );
    expect(detectProjectType("/repo")).toBe("express");
  });

  it("detects CLI from bin field", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ bin: { mycli: "./dist/cli.js" } }),
    );
    expect(detectProjectType("/repo")).toBe("cli");
  });

  it("detects library from main field", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ main: "./dist/index.js" }),
    );
    expect(detectProjectType("/repo")).toBe("library");
  });

  it("detects library from exports field", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ exports: { ".": "./dist/index.js" } }),
    );
    expect(detectProjectType("/repo")).toBe("library");
  });

  it("returns generic when no signals match", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ name: "my-project", scripts: { start: "node index.js" } }),
    );
    expect(detectProjectType("/repo")).toBe("generic");
  });

  it("returns generic when no package.json exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(detectProjectType("/repo")).toBe("generic");
  });

  it("returns generic when package.json is malformed", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockReadFileSync.mockReturnValue("not json");
    expect(detectProjectType("/repo")).toBe("generic");
  });

  it("prioritizes Next.js over express when both present", () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("next.config.js") || s.endsWith("package.json");
    });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    );
    expect(detectProjectType("/repo")).toBe("nextjs");
  });
});

// ─── hashPort ────────────────────────────────────────────────────────────────

describe("hashPort", () => {
  it("returns a port in [10000, 60000)", () => {
    const port = hashPort("my-branch");
    expect(port).toBeGreaterThanOrEqual(10000);
    expect(port).toBeLessThan(60000);
  });

  it("returns the same port for the same branch name", () => {
    expect(hashPort("feature/test")).toBe(hashPort("feature/test"));
  });

  it("returns different ports for different branch names", () => {
    expect(hashPort("feature/a")).not.toBe(hashPort("feature/b"));
  });
});

// ─── getStartCommand ──────────────────────────────────────────────────────────

describe("getStartCommand", () => {
  it("returns vite preview with --host 127.0.0.1", () => {
    const result = getStartCommand("vite", 3000);
    expect(result.cmd).toBe("npx");
    expect(result.args).toEqual(["vite", "preview", "--host", "127.0.0.1", "--port", "3000"]);
  });

  it("returns next start with --hostname 127.0.0.1", () => {
    const result = getStartCommand("nextjs", 4000);
    expect(result.cmd).toBe("npx");
    expect(result.args).toEqual(["next", "start", "--hostname", "127.0.0.1", "-p", "4000"]);
  });

  it("returns npm start for express without host flags", () => {
    const result = getStartCommand("express", 5000);
    expect(result.cmd).toBe("npm");
    expect(result.args).toEqual(["start"]);
  });

  it("returns npm start for generic without host flags", () => {
    const result = getStartCommand("generic", 5000);
    expect(result.cmd).toBe("npm");
    expect(result.args).toEqual(["start"]);
  });
});

// ─── isPlaywrightMCPAvailable ────────────────────────────────────────────────

describe("isPlaywrightMCPAvailable", () => {
  it("returns true when playwright is in mcpServers in ~/.claude.json", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }),
    );
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns true when playwright is in ~/.claude/settings.json", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("settings.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }),
    );
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns true by default (built-in plugin) when no config exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns true when config exists but no playwright in mcpServers (built-in plugin)", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { other: { command: "test" } } }),
    );
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });

  it("returns false when playwright is disabled for the most specific project path", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          "/my/project": {
            disabledMcpServers: ["plugin:playwright:playwright"],
          },
        },
      }),
    );
    expect(isPlaywrightMCPAvailable("/my/project")).toBe(false);
  });

  it("returns true when parent has playwright disabled but specific project does not", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          "/my": {
            disabledMcpServers: ["plugin:playwright:playwright"],
          },
          "/my/project": {},
        },
      }),
    );
    // Most specific match (/my/project) has no disabled list — built-in available
    expect(isPlaywrightMCPAvailable("/my/project")).toBe(true);
  });

  it("returns true when playwright is explicitly configured at project level", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          "/my/project": {
            mcpServers: { playwright: { command: "npx" } },
          },
        },
      }),
    );
    expect(isPlaywrightMCPAvailable("/my/project")).toBe(true);
  });

  it("returns true on malformed config (fail-open for built-in plugin)", () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".claude.json"),
    );
    mockReadFileSync.mockReturnValue("not json");
    expect(isPlaywrightMCPAvailable()).toBe(true);
  });
});

// ─── parseGateResult ─────────────────────────────────────────────────────────

describe("parseGateResult", () => {
  it("parses [GATE:PASS] marker", () => {
    const output = 'some output\n{"text":"[GATE:PASS]"}\n';
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(true);
    expect(result.failReason).toBeUndefined();
  });

  it("parses [GATE:FAIL] with reason", () => {
    const output = 'some output\n[GATE:FAIL] Build failed at typecheck\n';
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(false);
    expect(result.failReason).toBe("Build failed at typecheck");
  });

  it("parses [GATE:FAIL] without reason", () => {
    const output = "some output\n[GATE:FAIL]\n";
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(false);
    expect(result.failReason).toBeUndefined();
  });

  it("returns no-marker failure when no gate marker found", () => {
    const output = "some random output\nno markers here\n";
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(false);
    expect(result.failReason).toBe("no result marker");
  });

  it("last marker wins — PASS after FAIL", () => {
    const output = "[GATE:FAIL] First attempt failed\nfixer ran\n[GATE:PASS]\n";
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(true);
  });

  it("last marker wins — FAIL after PASS", () => {
    const output = "[GATE:PASS]\nregression found\n[GATE:FAIL] Regression after fix\n";
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(false);
    expect(result.failReason).toBe("Regression after fix");
  });

  it("handles marker embedded in JSON (JSONL output)", () => {
    const output = '{"type":"assistant","message":{"content":[{"type":"text","text":"[GATE:PASS]"}]}}\n';
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(true);
  });

  it("strips JSON suffix from FAIL reason in JSONL output", () => {
    const output = '{"type":"assistant","message":{"content":[{"type":"text","text":"[GATE:FAIL] Build failed at typecheck"}]}}\n';
    const result = parseGateResult(output);
    expect(result.finalSuccess).toBe(false);
    expect(result.failReason).toBe("Build failed at typecheck");
  });

  it("handles empty output", () => {
    const result = parseGateResult("");
    expect(result.finalSuccess).toBe(false);
    expect(result.failReason).toBe("no result marker");
  });
});

// ─── processGateLine ─────────────────────────────────────────────────────────

describe("processGateLine", () => {
  function makeStatus(): GateStatus {
    return {
      startedAt: Date.now(),
      phases: [
        { name: "Build Validation", status: "pending" },
        { name: "Smoke Test", status: "pending" },
        { name: "QA", status: "pending" },
      ],
      currentTool: "",
      turnCount: 0,
      bytesReceived: 0,
      fixAttempts: 0,
      maxFixAttempts: 3,
      taskCount: 5,
      logPath: "/logs/gate.jsonl",
    };
  }

  it("sets phase to running on [GATE:PHASE] marker", () => {
    const status = makeStatus();
    const msgId = { value: "" };
    processGateLine('[GATE:PHASE] Build Validation', status, msgId);
    expect(status.phases[0].status).toBe("running");
    expect(status.phases[1].status).toBe("pending");
  });

  it("sets previous running phase to passed when new phase starts", () => {
    const status = makeStatus();
    status.phases[0].status = "running";
    const msgId = { value: "" };
    processGateLine('[GATE:PHASE] Smoke Test', status, msgId);
    expect(status.phases[0].status).toBe("passed");
    expect(status.phases[1].status).toBe("running");
  });

  it("sets phase to passed on [GATE:OK] marker", () => {
    const status = makeStatus();
    status.phases[0].status = "running";
    const msgId = { value: "" };
    processGateLine('[GATE:OK] Build Validation', status, msgId);
    expect(status.phases[0].status).toBe("passed");
  });

  it("sets phase to failed on [GATE:WARN] marker", () => {
    const status = makeStatus();
    status.phases[0].status = "running";
    const msgId = { value: "" };
    processGateLine('[GATE:WARN] Build Validation', status, msgId);
    expect(status.phases[0].status).toBe("failed");
  });

  it("sets phase to fixed on [GATE:FIXED] marker", () => {
    const status = makeStatus();
    status.phases[0].status = "failed";
    const msgId = { value: "" };
    processGateLine('[GATE:FIXED] Build Validation', status, msgId);
    expect(status.phases[0].status).toBe("fixed");
  });

  it("updates fix attempts on [GATE:FIXING] marker", () => {
    const status = makeStatus();
    const msgId = { value: "" };
    processGateLine('[GATE:FIXING] 2', status, msgId);
    expect(status.fixAttempts).toBe(2);
  });

  it("tracks current tool from JSONL", () => {
    const status = makeStatus();
    const msgId = { value: "" };
    processGateLine('{"tool_name": "Bash", "input": "npm ci"}', status, msgId);
    expect(status.currentTool).toBe("Bash");
  });

  it("increments turn count on new message ID", () => {
    const status = makeStatus();
    const msgId = { value: "" };
    processGateLine('{"type":"assistant","message":{"id":"msg_abc123"}}', status, msgId);
    expect(status.turnCount).toBe(1);
    expect(msgId.value).toBe("msg_abc123");
  });

  it("does not increment turn count for same message ID", () => {
    const status = makeStatus();
    const msgId = { value: "msg_abc123" };
    processGateLine('{"type":"assistant","message":{"id":"msg_abc123"}}', status, msgId);
    expect(status.turnCount).toBe(0);
  });

  it("handles markers embedded in JSONL text fields", () => {
    const status = makeStatus();
    const msgId = { value: "" };
    processGateLine('{"type":"assistant","message":{"content":[{"type":"text","text":"[GATE:PHASE] QA"}]}}', status, msgId);
    expect(status.phases[2].status).toBe("running");
  });

  it("ignores lines with no markers", () => {
    const status = makeStatus();
    const msgId = { value: "" };
    processGateLine('{"type":"system","message":"starting"}', status, msgId);
    expect(status.phases[0].status).toBe("pending");
    expect(status.currentTool).toBe("");
    expect(status.turnCount).toBe(0);
  });
});
