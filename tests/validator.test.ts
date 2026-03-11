import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:net", () => ({
  createConnection: vi.fn(),
}));

import * as fs from "node:fs";
import { detectProjectType, hashPort, getStartCommand } from "../src/validator.js";

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
