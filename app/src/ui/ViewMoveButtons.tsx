import type { ReactNode } from "react";
import { IconButton } from "@carbon/react";
import { ArrowLeft, ArrowRight } from "@carbon/icons-react";

/**
 * A view's (or dashboard tab's) name input with "Move left" and "Move right" beside it: its place among the tabs, stored at
 * once. A button at the end it can't move past is disabled. Settings only, no dragging of tabs.
 */
export function ViewNameRow({ input, index, count, noun, onMove }: { input: ReactNode; index: number; count: number; noun: string; onMove(by: -1 | 1): void }) {
  return (
    <div className="view-name-row">
      {input}
      {count > 1 && (
        <div className="view-name-row__moves">
          <IconButton autoAlign kind="ghost" size="sm" align="top" label={`Move ${noun} left`} disabled={index <= 0} onClick={() => onMove(-1)}>
            <ArrowLeft />
          </IconButton>
          <IconButton autoAlign kind="ghost" size="sm" align="top" label={`Move ${noun} right`} disabled={index < 0 || index >= count - 1} onClick={() => onMove(1)}>
            <ArrowRight />
          </IconButton>
        </div>
      )}
    </div>
  );
}
