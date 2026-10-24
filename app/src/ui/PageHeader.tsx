import { useLocation } from "react-router";
import type { ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, Heading } from "@carbon/react";
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
      {/* A top-level page (no parents) shows itself as a link with a trailing slash ("Types /");
          deeper pages show their parents as links, ending in the current page as plain text. */}
      {breadcrumbs.length === 0 ? (
        <Breadcrumb>
          <BreadcrumbItem href={`#${pathname}`}>{currentLabel}</BreadcrumbItem>
        </Breadcrumb>
      ) : (
        <Breadcrumb noTrailingSlash>
          {breadcrumbs.map((b) => (
            <BreadcrumbItem key={b.href} href={b.href}>
              {b.label}
            </BreadcrumbItem>
          ))}
          {currentLabel && <BreadcrumbItem isCurrentPage>{currentLabel}</BreadcrumbItem>}
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
