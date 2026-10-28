import { useId } from "react";
import { useSearchParams } from "react-router";
import { Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { AiSettings } from "../ui/AiSettings";
import { ConnectionSettings } from "../ui/ConnectionSettings";
import { PageHeader } from "../ui/PageHeader";
import { ServerConnection } from "../ui/ServerConnection";
import { SyncSettings } from "../ui/SyncSettings";

/** The sections, in order; `?section=` opens one (the sync status's "Configure sync" leads to sync). */
const SECTIONS = ["server", "sync", "connections", "ai"] as const;

/**
 * Settings of this device and of the server it is connected to: the server (address, token), whether
 * this device syncs with it (and wiping data), the databases the server reads (connections), and the
 * language model for AI (the server's or this device's own).
 */
export function SettingsPage() {
  const uid = useId();
  const [params, setParams] = useSearchParams();
  const selected = Math.max(0, SECTIONS.indexOf(params.get("section") as (typeof SECTIONS)[number]));
  return (
    <div className="form-page">
      <PageHeader title="Settings" />
      <Tabs selectedIndex={selected} onChange={({ selectedIndex }) => setParams({ section: SECTIONS[selectedIndex] }, { replace: true })}>
        <TabList aria-label="Settings" id={`${uid}-tabs`}>
          <Tab>Server</Tab>
          <Tab>Sync</Tab>
          <Tab>Connections</Tab>
          <Tab>AI</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <ServerConnection />
          </TabPanel>
          <TabPanel>
            <SyncSettings />
          </TabPanel>
          <TabPanel>
            <ConnectionSettings />
          </TabPanel>
          <TabPanel>
            <AiSettings />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
