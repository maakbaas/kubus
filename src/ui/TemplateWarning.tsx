import { WarningAltFilled } from "@carbon/icons-react";
import type { ReactNode } from "react";

/**
 * A template's warning (a failing {{ }} section), as Carbon shows warnings: the yellow warning
 * icon before the message. Inline, so it can sit inside text.
 */
export function TemplateWarning({ children }: { children: ReactNode }) {
  return (
    <span className="template-warning">
      <WarningAltFilled size={16} aria-label="Warning" />
      {children}
    </span>
  );
}
