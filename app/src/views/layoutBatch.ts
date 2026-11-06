// Layout work of many boxes on a page (each table of a grouped block fills its row and positions its header), done
// together: first every box's resets, then every measurement, then every change. Done one box after the other, each
// box's change made the next box's measurement lay the page out again: with a table per group (grouped by a list,
// many groups) dozens of layouts of the whole page before it showed.

/** One box's work: `reset` undoes what it set (to measure it bare), `measure` only reads, `apply` only writes. */
export interface LayoutJob {
  reset?(): void;
  measure(): void;
  apply(): void;
}

const queue = new Set<LayoutJob>();
let pending = false;

function flush() {
  pending = false;
  const jobs = [...queue];
  queue.clear();
  for (const j of jobs) j.reset?.();
  for (const j of jobs) j.measure();
  for (const j of jobs) j.apply();
}

/**
 * Runs `job` with every other one asked for in the same task: right after it (a microtask), so still before the
 * frame is painted, whether asked from a layout effect or from a size observer.
 */
export function requestLayout(job: LayoutJob) {
  queue.add(job);
  if (!pending) {
    pending = true;
    queueMicrotask(flush);
  }
}

// One observer for all: the boxes that changed size are reported in one callback, so their work is one batch.
const handlers = new Map<Element, Set<() => void>>();
let observer: ResizeObserver | null = null;

/** Calls `onResize` whenever `el` changes size (not now: the caller does its work once itself); returns the call that stops it. */
export function observeSize(el: Element, onResize: () => void): () => void {
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) handlers.get(e.target)?.forEach((h) => h());
  });
  let set = handlers.get(el);
  if (!set) {
    set = new Set();
    handlers.set(el, set);
    observer.observe(el);
  }
  set.add(onResize);
  return () => {
    set.delete(onResize);
    if (set.size === 0) {
      handlers.delete(el);
      observer?.unobserve(el);
    }
  };
}
