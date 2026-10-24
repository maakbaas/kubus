import type { ReactNode } from "react";
import { Link } from "@carbon/react";
import { openModeOf, useOpenRelated } from "../workspace/Workspace";

/** A link to a related item: click = here, Ctrl/Cmd click = beside, middle click = new tab. */
export function RelatedLink({ path, children }: { path: string; children: ReactNode }) {
  const openRelated = useOpenRelated();
  return (
    <Link
      href={`#${path}`}
      data-own-click
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation(); // don't also start editing the field
        openRelated(path, openModeOf(e));
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        openRelated(path, "tab");
      }}
    >
      {children}
    </Link>
  );
}
