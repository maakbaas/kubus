// The text of whatever was thrown. React-free, so the worker, the headless device and the UI share it.

/** An error's message; anything else thrown, as text. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
