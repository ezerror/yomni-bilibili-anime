/** Cancellation fields survive the public IPC bridge and independent bundles. */
export function isServiceCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === "AbortError" || value.code === "CANCELLED";
}
