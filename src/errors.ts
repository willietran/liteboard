/** Extracts a human-readable message from an unknown caught value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Extracts stderr from a child_process error, or empty string. */
export function getErrorStderr(error: unknown): string {
  const stderr = (error as { stderr?: { toString?: () => string } | string }).stderr;
  if (typeof stderr === "string") return stderr.trim();
  if (stderr && typeof stderr.toString === "function") return stderr.toString().trim();
  return "";
}
