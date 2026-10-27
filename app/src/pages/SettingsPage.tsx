import { useId } from "react";
import { useSearchParams } from "react-router";
import { Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { AiSettings } from "../ui/AiSettings";
import { PageHeader } from "../ui/PageHeader";
import { ServerSettings } from "../ui/ServerSettings";
import { SyncSettings } from "../ui/SyncSettings";

/** The sections, in order; `?section=` opens one (the sync status's "Configure sync" leads to sync). */
const SECTIONS = ["sync", "ai", "server"] as const;

/** Settings of this device (where it syncs to, the language model for AI), and of the server it syncs with. */
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
          <Tab>Server</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <SyncSettings />
          </TabPanel>
          <TabPanel>
            <AiSettings />
          </TabPanel>
          <TabPanel>
            <ServerSettings />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
