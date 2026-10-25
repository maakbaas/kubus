import { Stack } from "@carbon/react";
import help from "../help/components.md?raw";
import type { FieldDef } from "../domain/model";
import { PageHeader } from "../ui/PageHeader";
import { ViewField } from "./ItemPage";

/** The help text as the one field of a (made up) item: a Markdown field. */
const HELP: FieldDef = {
  id: "help",
  collectionId: "",
  name: "Help",
  kind: "markdown",
  targetCollectionId: null,
  componentId: null,
  componentArgs: {},
  choiceFilter: [],
  toggleIcon: null,
  aiPrompt: null,
  aiOutput: null,
  position: 0,
};

const nothing = () => undefined;

/**
 * Help (components and `{{ }}` code, AI fields). Laid out exactly as an item's page: a title, and one
 * Markdown field whose name is hidden, holding the text (`help/components.md`, which "Write with
 * AI" in the component editor is given too).
 */
export function HelpPage() {
  return (
    <div className="form-page item-view">
      <PageHeader title="Help" />
      <Stack gap={7} className="item-fields">
        <div className="item-field--no-label">
          <ViewField field={HELP} value={help} refs={{}} onEdit={nothing} onSave={nothing} readOnly />
        </div>
      </Stack>
    </div>
  );
}
