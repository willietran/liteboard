import * as path from "node:path";

/** Returns the absolute path to the artifacts directory for a given project. */
export function artifactsDir(projectDir: string): string {
  return path.join(projectDir, "artifacts");
}
