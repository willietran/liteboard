import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
}));

import { mkdirSync } from "node:fs";
import { writeWithMkdir } from "../src/fs-helpers.js";

const mockMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("writeWithMkdir", () => {
  it("calls writeFn directly when directory exists", () => {
    const writeFn = vi.fn();
    writeWithMkdir("/some/dir/file.txt", writeFn);
    expect(writeFn).toHaveBeenCalledOnce();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("creates directory and retries on ENOENT", () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const writeFn = vi.fn()
      .mockImplementationOnce(() => { throw enoent; })
      .mockImplementationOnce(() => undefined);

    writeWithMkdir("/some/dir/file.txt", writeFn);

    expect(mockMkdirSync).toHaveBeenCalledWith("/some/dir", { recursive: true });
    expect(writeFn).toHaveBeenCalledTimes(2);
  });

  it("propagates non-ENOENT errors without retrying", () => {
    const permErr = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const writeFn = vi.fn().mockImplementationOnce(() => { throw permErr; });

    expect(() => writeWithMkdir("/some/dir/file.txt", writeFn)).toThrow("EACCES");
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(writeFn).toHaveBeenCalledOnce();
  });

  it("propagates errors from the retry attempt", () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const retryErr = new Error("disk full");
    const writeFn = vi.fn()
      .mockImplementationOnce(() => { throw enoent; })
      .mockImplementationOnce(() => { throw retryErr; });

    expect(() => writeWithMkdir("/some/dir/file.txt", writeFn)).toThrow("disk full");
  });
});
