import type { ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, Heading, Link } from "@carbon/react";
import { Home as HomeIcon } from "@carbon/icons-react";
import { useTabTitle } from "../workspace/Workspace";

interface Props {
  title: ReactNode;
  /** Name of this page (its workspace tab's title); defaults to `title` when that is text. */
  current?: string;
  subtitle?: ReactNode;
  /** Ancestor pages, after Home; the page itself isn't one (its title, right below, names it). */
  breadcrumbs?: { label: string; href: string }[];
  actions?: ReactNode;
}

export function PageHeader({ title, current, subtitle, breadcrumbs = [], actions }: Props) {
  const currentLabel = current ?? (typeof title === "string" ? title : undefined);
  // The page's name is also its workspace tab's title.
  useTabTitle(currentLabel);
  return (
    <div className="page-header">
      {/* Breadcrumb and title on the left (a long title wraps there), the actions at the very top
          right; the subtitle below spans the full width. */}
      <div className="page-header__row">
        <div className="page-header__main">
      {/* A long breadcrumb is cut with "…": its whole text is its title (hover). */}
      {/* Home (an icon) and the page's parents as links, each followed by a slash ("⌂ / Collections / Books /"); not the page
          itself: its title, right below, names it, and on a phone (a crumb per line) it took a line. */}
      <Breadcrumb>
        <HomeCrumb />
        {breadcrumbs.map((b) => (
          <BreadcrumbItem key={b.href} href={b.href} title={b.label}>
            {b.label}
          </BreadcrumbItem>
        ))}
      </Breadcrumb>
          {typeof title === "string" ? <Heading className="page-header__title">{title}</Heading> : title}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
      {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
    </div>
  );
}

/** The breadcrumb's first item: the Home page, as its icon. */
function HomeCrumb() {
  return (
    <BreadcrumbItem className="breadcrumb-home">
      <Link href="#/" title="Home" aria-label="Home">
        <HomeIcon size={16} aria-hidden="true" />
      </Link>
    </BreadcrumbItem>
  );
}

/** The breadcrumb a collection's pages start with: Remotes for a remote collection, else Collections. */
export function collectionsCrumb(collection: { source?: unknown }): { label: string; href: string } {
  return collection.source ? { label: "Remotes", href: "#/remotes" } : { label: "Collections", href: "#/collections" };
}
