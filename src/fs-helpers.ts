import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Shared ENOENT → mkdir → retry pattern for file writes. */
export function writeWithMkdir(filePath: string, writeFn: () => void): void {
  try {
    writeFn();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFn();
    } else {
      throw e;
    }
  }
}
