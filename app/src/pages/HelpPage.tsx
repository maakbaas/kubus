import { useId } from "react";
import { useSearchParams } from "react-router";
import { Stack, Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import components from "../help/components.md?raw";
import api from "../help/api.md?raw";
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
  toggleIcon: null, strikeThrough: false,
  aiPrompt: null,
  aiOutput: null,
  position: 0,
};

const nothing = () => undefined;

/** The sections, in order; `?section=` opens one. */
const SECTIONS = [
  { id: "components", title: "Components", text: components },
  { id: "api", title: "API", text: api },
] as const;

/**
 * Help, in tabs: components and `{{ }}` code with AI fields (`help/components.md`, which "Write
 * with AI" in the component editor is given too), and the server's HTTP API (`help/api.md`).
 * Each laid out exactly as an item's page: one Markdown field whose name is hidden.
 */
export function HelpPage() {
  const uid = useId();
  const [params, setParams] = useSearchParams();
  const selected = Math.max(0, SECTIONS.findIndex((s) => s.id === params.get("section")));
  return (
    <div className="form-page item-view help-page">
      <PageHeader title="Help" />
      <Tabs selectedIndex={selected} onChange={({ selectedIndex }) => setParams({ section: SECTIONS[selectedIndex].id }, { replace: true })}>
        <TabList aria-label="Help" id={`${uid}-tabs`}>
          {SECTIONS.map((s) => (
            <Tab key={s.id}>{s.title}</Tab>
          ))}
        </TabList>
        <TabPanels>
          {SECTIONS.map((s) => (
            <TabPanel key={s.id}>
              <Stack gap={7} className="item-fields">
                <div className="item-field--no-label">
                  <ViewField field={HELP} value={s.text} refs={{}} onEdit={nothing} onSave={nothing} readOnly />
                </div>
              </Stack>
            </TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    </div>
  );
}
