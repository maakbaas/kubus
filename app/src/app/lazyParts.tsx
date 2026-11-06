import { lazy, type ComponentType } from "react";
import { loadCodeHighlight } from "../ui/useCodeHighlight";

// Parts of the app left out of the main chunk, which is evaluated before anything shows: each is loaded the first
// time it is shown, and all of them in the background once the app has started (preloadLazyParts), so that is
// rarely waited for. Pages seldom opened first, and the Markdown editor (Milkdown and ProseMirror), which only
// shows once a Markdown field is clicked.

const loaders: (() => Promise<unknown>)[] = [loadCodeHighlight];

/** A component loaded on first render (React.lazy; a Suspense boundary above shows meanwhile), preloaded in the background. */
function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  loaders.push(load);
  return lazy(() => load().then((c) => ({ default: c })));
}

export const SettingsPage = lazyPart(() => import("../pages/SettingsPage").then((m) => m.SettingsPage));
export const HelpPage = lazyPart(() => import("../pages/HelpPage").then((m) => m.HelpPage));
export const SpacesPage = lazyPart(() => import("../pages/SpacesPage").then((m) => m.SpacesPage));
export const ComponentsPage = lazyPart(() => import("../pages/ComponentsPage").then((m) => m.ComponentsPage));
export const ComponentEditorPage = lazyPart(() => import("../pages/ComponentEditorPage").then((m) => m.ComponentEditorPage));
export const CollectionEditorPage = lazyPart(() => import("../pages/CollectionEditorPage").then((m) => m.CollectionEditorPage));
export const RemotesPage = lazyPart(() => import("../pages/RemotesPage").then((m) => m.RemotesPage));
export const MarkdownEditor = lazyPart(() => import("../ui/MarkdownEditor").then((m) => m.MarkdownEditor));

let preloaded = false;

/** Loads every lazy part, one at a time when the browser is idle: called once the app has shown its first page. */
export function preloadLazyParts() {
  if (preloaded) return;
  preloaded = true;
  const idle = (run: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 50));
  const next = (i: number) => {
    if (i >= loaders.length) return;
    idle(() => {
      loaders[i]().then(
        () => next(i + 1),
        () => next(i + 1), // shown when it is wanted (and loaded again then)
      );
    });
  };
  // A moment after the first page has drawn, so the start isn't slowed by it.
  setTimeout(() => next(0), 1000);
}
