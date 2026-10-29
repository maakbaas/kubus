import { IconButton, ProgressBar } from "@carbon/react";
import { Close } from "@carbon/icons-react";

/**
 * The one progress bar of the app (rows loading into a block), with a small "×" icon button at its
 * right to stop it: a 32px icon button at the row's right edge, so it lines up with the buttons of
 * the heading above (a block's menus). Without `onStop` (what can't be stopped) there is no button.
 */
export function LoadingBar({
  label,
  value,
  max,
  onStop,
  stopLabel = "Stop loading",
  className,
}: {
  label: string;
  /** Without a value the bar is empty (the total isn't known yet). */
  value?: number;
  max?: number;
  onStop?(): void;
  stopLabel?: string;
  className?: string;
}) {
  return (
    <div className={`loading-bar${className ? ` ${className}` : ""}`}>
      <ProgressBar className="loading-bar__bar" size="small" label={label} value={value ?? 0} max={Math.max(max ?? 1, 1)} />
      {onStop && (
        <IconButton autoAlign kind="ghost" size="sm" align="top-end" label={stopLabel} onClick={onStop}>
          <Close />
        </IconButton>
      )}
    </div>
  );
}
