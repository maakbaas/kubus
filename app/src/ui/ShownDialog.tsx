import type { ReactNode } from "react";
import { useMountedDialog } from "./useMountedDialog";

/**
 * A dialog mounted only while `shown` (its `open` from useMountedDialog, which also gives focus back to what opened it).
 * Mounted and hidden instead, Carbon's Modal measured its content (a forced layout of the page) on every render of what
 * holds it: a page, a table block, an editor as it is typed in.
 */
export function ShownDialog({ shown, children }: { shown: boolean; children: (open: boolean) => ReactNode }) {
  return shown ? <Mounted>{children}</Mounted> : null;
}

function Mounted({ children }: { children: (open: boolean) => ReactNode }) {
  const open = useMountedDialog();
  return <>{children(open)}</>;
}
