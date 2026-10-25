import type { ReactNode } from "react";
import { useAiCellState } from "../app/useAi";

/**
 * An AI value (`children`) or, in its place, what it is doing: being generated (also when a value
 * is there and another is asked for), failed (with the reason), or, when there is no value yet,
 * waiting for a go-ahead or a model. Just the value otherwise.
 */
export function AiStatus({ itemId, fieldId, compact, children }: { itemId: string; fieldId: string; /** In a table cell or card: one line, cut off with "…" (the reason is in the tooltip). */ compact?: boolean; children?: ReactNode }) {
  const state = useAiCellState(itemId, fieldId);
  if (state === "running" || state === "queued") return <span className="ai-status">Generating…</span>;
  if (state.startsWith("error: ")) {
    const reason = state.slice("error: ".length);
    return (
      <span className={`ai-status ai-status--error${compact ? " ai-status--compact" : ""}`} title={reason}>
        ⚠ {reason}
      </span>
    );
  }
  if (state === "held" && !children) return <span className="ai-status">Waiting to generate</span>;
  return <>{children}</>;
}
