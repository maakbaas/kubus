import { Button, IconButton } from "@carbon/react";
import { Add } from "@carbon/icons-react";

/**
 * A page's "New …" action for its header: a primary button with a + icon. Where the header is
 * narrow only the + shows (the label becomes its tooltip); a long label ends in "…".
 */
export function NewButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <>
      <Button size="sm" renderIcon={Add} iconDescription={label} onClick={onClick} className="new-button new-button--full">
        <span className="new-button__label">{label}</span>
      </Button>
      <IconButton autoAlign size="sm" kind="primary" label={label} align="bottom-end" onClick={onClick} className="new-button new-button--icon">
        <Add />
      </IconButton>
    </>
  );
}
