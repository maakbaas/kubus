import { useEffect, useState } from "react";

type Highlighter = typeof import("./codeHighlight");
let loaded: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

/** codeHighlight.ts: refractor and its ~40 languages, a chunk of its own (registering them took a while when the app started). */
export function loadCodeHighlight(): Promise<Highlighter> {
  loading ??= import("./codeHighlight").then(
    (m) => (loaded = m),
    (e) => {
      loading = null; // a later use retries
      throw e;
    },
  );
  return loading;
}

/** The code highlighter once loaded (it starts loading when first `wanted`); null before: code shows uncoloured until then. */
export function useCodeHighlight(wanted = true): Highlighter | null {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(loaded);
  useEffect(() => {
    if (!wanted || highlighter) return;
    let live = true;
    loadCodeHighlight().then((h) => live && setHighlighter(h), (e) => console.error("Loading the code highlighter failed", e));
    return () => {
      live = false;
    };
  }, [wanted, highlighter]);
  return wanted ? highlighter : null;
}
