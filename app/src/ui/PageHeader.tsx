import { useLocation } from "react-router";
import type { ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, Heading, Link } from "@carbon/react";
import { Home as HomeIcon } from "@carbon/icons-react";
import { useTabTitle } from "../workspace/Workspace";

interface Props {
  title: ReactNode;
  /** Name of this page in the breadcrumb; defaults to `title` when that is text. */
  current?: string;
  subtitle?: ReactNode;
  /** Ancestor pages; the current page is always appended as the last, non-clickable item. */
  breadcrumbs?: { label: string; href: string }[];
  actions?: ReactNode;
}

export function PageHeader({ title, current, subtitle, breadcrumbs = [], actions }: Props) {
  const currentLabel = current ?? (typeof title === "string" ? title : undefined);
  // The page's name is also its workspace tab's title.
  useTabTitle(currentLabel);
  const { pathname } = useLocation();
  return (
    <div className="page-header">
      {/* Breadcrumb and title on the left (a long title wraps there), the actions at the very top
          right; the subtitle below spans the full width. */}
      <div className="page-header__row">
        <div className="page-header__main">
      {/* A long breadcrumb is cut with "…": its whole text is its title (hover). */}
      {/* It starts at Home, an icon only. The Home page shows just that, as a link with a trailing slash ("⌂ /"); other
          pages show their parents as links after it, ending in the current page as plain text. */}
      {pathname === "/" ? (
        <Breadcrumb>
          <HomeCrumb />
        </Breadcrumb>
      ) : (
        <Breadcrumb noTrailingSlash>
          <HomeCrumb />
          {breadcrumbs.map((b) => (
            <BreadcrumbItem key={b.href} href={b.href} title={b.label}>
              {b.label}
            </BreadcrumbItem>
          ))}
          {currentLabel && <BreadcrumbItem isCurrentPage title={currentLabel}>{currentLabel}</BreadcrumbItem>}
        </Breadcrumb>
      )}
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
