import { describe, it, expect } from "vitest";
import { createMutex } from "../src/mutex.js";

describe("createMutex", () => {
  it("serializes concurrent operations in order", async () => {
    const serialize = createMutex();
    const order: number[] = [];

    const p1 = serialize(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return "first";
    });

    const p2 = serialize(async () => {
      order.push(2);
      return "second";
    });

    const p3 = serialize(async () => {
      order.push(3);
      return "third";
    });

    const results = await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual(["first", "second", "third"]);
  });

  it("propagates errors from the serialized function", async () => {
    const serialize = createMutex();

    await expect(
      serialize(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("releases lock on throw so subsequent operations proceed", async () => {
    const serialize = createMutex();
    const order: number[] = [];

    // First: throws
    const p1 = serialize(async () => {
      order.push(1);
      throw new Error("fail");
    }).catch(() => {});

    // Second: should still run
    const p2 = serialize(async () => {
      order.push(2);
      return "ok";
    });

    await p1;
    const result = await p2;

    expect(order).toEqual([1, 2]);
    expect(result).toBe("ok");
  });
});
