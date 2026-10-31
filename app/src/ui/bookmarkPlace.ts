import { dashboardIcon, type Dashboard } from "../domain/dashboards";
import { parseStoredDashboardLink, parseStoredLink } from "../domain/linkTargets";
import type { Collection } from "../domain/model";

/**
 * Where a bookmark's link leads, as the side nav and the Bookmarks page say it: the icon of its collection or dashboard
 * and what it is ("Book" for an item, "Field of Book", "View of Books", "Block of Books", "Collection", "Dashboard",
 * "View of Health"). Null when the link names neither (it is then deleted with what it named, so this is rare).
 */
export function bookmarkPlace(link: string, collections: Collection[], dashboards: Dashboard[]): { icon: string | null; text: string } | null {
  const onDashboard = parseStoredDashboardLink(link);
  if (onDashboard) {
    const d = dashboards.find((x) => x.id === onDashboard.dashboardId);
    if (!d) return null;
    const text = onDashboard.blockId ? `Block of ${d.name}` : onDashboard.viewId ? `View of ${d.name}` : "Dashboard";
    return { icon: dashboardIcon(d), text };
  }
  const page = parseStoredLink(link);
  const c = page && collections.find((x) => x.id === page.collectionId);
  if (!page || !c) return null;
  const text = page.fieldId
    ? `Field of ${c.name}`
    : page.blockId
      ? `Block of ${page.itemId ? c.name : c.pluralName}`
      : page.itemId
        ? page.viewId ? `View of ${c.name}` : c.name
        : page.viewId ? `View of ${c.pluralName}` : "Collection";
  return { icon: c.icon, text };
}
