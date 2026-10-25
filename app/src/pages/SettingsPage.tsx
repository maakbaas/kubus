import { useId } from "react";
import { useSearchParams } from "react-router";
import { Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { AiSettings } from "../ui/AiSettings";
import { PageHeader } from "../ui/PageHeader";
import { SyncSettings } from "../ui/SyncSettings";

/** The sections, in order; `?section=` opens one (the sync status's "Configure sync" leads to sync). */
const SECTIONS = ["sync", "ai"] as const;

/** Settings of this device: where it syncs to, and the language model for AI. */
export function SettingsPage() {
  const uid = useId();
  const [params, setParams] = useSearchParams();
  const selected = Math.max(0, SECTIONS.indexOf(params.get("section") as (typeof SECTIONS)[number]));
  return (
    <div className="form-page">
      <PageHeader title="Settings" />
      <Tabs selectedIndex={selected} onChange={({ selectedIndex }) => setParams({ section: SECTIONS[selectedIndex] }, { replace: true })}>
        <TabList aria-label="Settings" id={`${uid}-tabs`}>
          <Tab>Sync</Tab>
          <Tab>AI</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <SyncSettings />
          </TabPanel>
          <TabPanel>
            <AiSettings />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
