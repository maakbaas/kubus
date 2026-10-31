import { useId, useRef } from "react";
import { useSearchParams } from "react-router";
import { Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { AiSettings } from "../ui/AiSettings";
import { ApiTokens } from "../ui/ApiTokens";
import { BackupSettings } from "../ui/BackupSettings";
import { ConnectionSettings } from "../ui/ConnectionSettings";
import { DisplaySettings } from "../ui/DisplaySettings";
import { PageHeader } from "../ui/PageHeader";
import { ServerConnection } from "../ui/ServerConnection";
import { SyncSettings } from "../ui/SyncSettings";
import { TabMenu, useClippedTabs } from "../ui/TabMenu";

/**
 * The sections, in order; `?section=` opens one (the sync status's "Configure sync" leads to sync). First what works
 * without a server (how the app looks, AI, a backup), from Server on what is the server's.
 */
const SECTIONS = ["display", "ai", "backup", "server", "sync", "connections", "tokens"] as const;
const NAMES: Record<(typeof SECTIONS)[number], string> = { display: "Display", ai: "AI", backup: "Backup", server: "Server", sync: "Sync", connections: "Connections", tokens: "API tokens" };

/**
 * The settings: how the app looks (theme, maps; synced like content), the language model for AI (this device's own,
 * or the server's, set up here too), a backup of this device's data and restoring one; then the server (address,
 * token), whether this device syncs with it (and wiping data), the databases the server reads (connections) and the
 * server's API tokens for other tools.
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
          {panel(<DisplaySettings />)}
          {panel(<AiSettings />)}
          {panel(<BackupSettings />)}
          {panel(<ServerConnection />)}
          {panel(<SyncSettings />)}
          {panel(<ConnectionSettings />)}
          {panel(<ApiTokens />)}
        </TabPanels>
      </Tabs>
    </div>
  );
}
