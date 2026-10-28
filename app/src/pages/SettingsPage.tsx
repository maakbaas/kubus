import { useId, useRef } from "react";
import { useSearchParams } from "react-router";
import { Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { AiSettings } from "../ui/AiSettings";
import { ApiTokens } from "../ui/ApiTokens";
import { ConnectionSettings } from "../ui/ConnectionSettings";
import { MapSettings } from "../ui/MapSettings";
import { PageHeader } from "../ui/PageHeader";
import { ServerConnection } from "../ui/ServerConnection";
import { SyncSettings } from "../ui/SyncSettings";
import { TabMenu, useClippedTabs } from "../ui/TabMenu";

/** The sections, in order; `?section=` opens one (the sync status's "Configure sync" leads to sync). */
const SECTIONS = ["server", "sync", "connections", "ai", "maps", "tokens"] as const;
const NAMES: Record<(typeof SECTIONS)[number], string> = { server: "Server", sync: "Sync", connections: "Connections", ai: "AI", maps: "Maps", tokens: "API tokens" };

/**
 * Settings of this device and of the server it is connected to: the server (address, token), whether
 * this device syncs with it (and wiping data), the databases the server reads (connections), the
 * language model for AI (the server's or this device's own), how maps look (the server's, else this device's) and
 * the server's API tokens for other tools.
 */
export function SettingsPage() {
  const uid = useId();
  const [params, setParams] = useSearchParams();
  const selected = Math.max(0, SECTIONS.indexOf(params.get("section") as (typeof SECTIONS)[number]));
  const select = (index: number) => setParams({ section: SECTIONS[index] }, { replace: true });
  // Tabs that don't fit are one tab and a down arrow listing them, as a collection's views.
  const bar = useRef<HTMLDivElement>(null);
  const clipped = useClippedTabs(bar);
  // Each section's parts one rhythm apart (`.settings-panel`).
  const panel = (content: React.ReactNode) => (
    <TabPanel>
      <div className="settings-panel">{content}</div>
    </TabPanel>
  );
  return (
    <div className="form-page settings-page">
      <PageHeader title="Settings" />
      <Tabs selectedIndex={selected} onChange={({ selectedIndex }) => select(selectedIndex)}>
        <div className="views-bar" ref={bar}>
          <TabList aria-label="Settings" id={`${uid}-tabs`}>
            {SECTIONS.map((s) => (
              <Tab key={s}>{NAMES[s]}</Tab>
            ))}
          </TabList>
          {clipped && <TabMenu label="Settings" items={SECTIONS.map((s) => ({ id: s, name: NAMES[s] }))} activeId={SECTIONS[selected]} onSelect={(id) => select(SECTIONS.indexOf(id as (typeof SECTIONS)[number]))} />}
        </div>
        <TabPanels>
          {panel(<ServerConnection />)}
          {panel(<SyncSettings />)}
          {panel(<ConnectionSettings />)}
          {panel(<AiSettings />)}
          {panel(<MapSettings />)}
          {panel(<ApiTokens />)}
        </TabPanels>
      </Tabs>
    </div>
  );
}
