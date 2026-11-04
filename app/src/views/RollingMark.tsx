import { IconButton } from "@carbon/react";
import { Activity } from "@carbon/icons-react";

/** Before a period that moves on with time ("This week", "Last 7 days": counted from now), on the filter bar and in the filter panel. */
export function RollingMark() {
  return (
    <IconButton autoAlign kind="ghost" size="sm" align="bottom-start" label="Updates automatically" className="rolling-mark">
      <Activity />
    </IconButton>
  );
}
