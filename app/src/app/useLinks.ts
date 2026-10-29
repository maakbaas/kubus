import { useMemo } from "react";
import { describeLink, resolveNameLink, type LinkData } from "../domain/links";
import { openExternal } from "../platform/openExternal";
import { useOpenRelated, type OpenMode } from "../workspace/Workspace";
import { useStore } from "./store";

/**
 * Markdown links to pages of the app. They are written by name (`book/dune#author`, `dashboards/health/daily#chart`: domain/links.ts)
 * and stored by id (`#/collections/…`, `#/dashboards/…`), so a rename breaks none; the editor shows the name again.
 */
export function useLinks() {
  const { repo, space, collections, dashboards } = useStore();
  const openRelated = useOpenRelated();
  return useMemo(() => {
    const data: LinkData = {
      collections,
      views: (c) => repo.listViews(c.id, space.id),
      items: (c) => repo.listLabels(c),
      dashboards,
      tabs: (d) => repo.listDashboardViews(d.id, space.id),
    };
    /** What to store for a link as typed: its id form when it names a page, else as it is. */
    const toStored = async (href: string) => (await resolveNameLink(href, data).catch(() => null)) ?? href;
    /** What to show for a stored link: its name form when it still names a page, else as it is. */
    const toShown = async (href: string) => (await describeLink(href, data).catch(() => null)) ?? href;
    /** Opens a link: a page of the app here, beside or in a new tab; anything else outside. */
    const open = async (href: string, mode: OpenMode = "here") => {
      const stored = href.startsWith("#/") ? href : await toStored(href);
      if (stored.startsWith("#/")) openRelated(stored.slice(1), mode);
      else await openExternal(stored);
    };
    return { toStored, toShown, open };
  }, [repo, space.id, collections, dashboards, openRelated]);
}
