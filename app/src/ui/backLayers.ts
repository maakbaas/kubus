import { useEffect, useRef } from "react";

// Layers over the page that back and forward act on first, as a phone's photo viewer does: while one is open (the image
// lightbox), back closes it and forward does nothing, so the page behind it doesn't change. The workspace asks
// (`takeBackForward`) before it moves a tab's history: mouse buttons, Alt+arrows, the browser keys and edge swipes.

const layers: { current: () => void }[] = [];

/** While `open`, back closes this layer (`close`) instead of going back, and forward does nothing. */
export function useBackCloses(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    layers.push(latest);
    return () => {
      const at = layers.lastIndexOf(latest);
      if (at >= 0) layers.splice(at, 1);
    };
  }, [open]);
}

/** Whether a layer is open (then back closes it and forward does nothing). */
export const backLayerOpen = (): boolean => layers.length > 0;

/** Lets the newest open layer take a back or forward: true when one did (back closed it), so the history isn't moved. */
export function takeBackForward(direction: "back" | "forward"): boolean {
  const top = layers[layers.length - 1];
  if (!top) return false;
  if (direction === "back") top.current();
  return true;
}
