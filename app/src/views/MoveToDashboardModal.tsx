import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Dropdown, InlineNotification, Modal, Stack } from "@carbon/react";
import { Add } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { dashboardIcon, FIRST_TAB_NAME, movedBlock, newDashboardName, tabToMoveTo, type Dashboard } from "../domain/dashboards";
import { newId, now, type Collection } from "../domain/model";
import type { FilterRule } from "../domain/query";
import { NOTHING_COLLAPSED, type ViewBlock } from "../domain/views";
import { CollectionIcon } from "../ui/collectionIcons";
import { errorMessage } from "../ui/useConfirm";
import { useMountedDialog } from "../ui/useMountedDialog";
import { useOpenRelated } from "../workspace/Workspace";

/** The Dropdown's last choice: a dashboard made for the block, in this space only (as New dashboard makes one). */
const NEW_DASHBOARD = { id: "", name: "New dashboard", icon: null } as const;
type Choice = Pick<Dashboard, "id" | "name" | "icon">;

function DashboardLabel({ choice }: { choice: Choice }) {
  return (
    <span className="view-kind">
      {choice.id ? <CollectionIcon name={dashboardIcon(choice)} /> : <Add size={16} />}
      {choice.name}
    </span>
  );
}

/**
 * "Move to a dashboard" (Block settings of a collection view's or item page's block): the block, naming its collection
 * (several kept), with the filter it built on made part of its own (domain/dashboards.ts movedBlock), is put last on the
 * chosen dashboard's starred (else first) tab in the shown space, or on a new dashboard's, and taken out of its place
 * (`onTakeOut`; without it, the place's last block, it is copied); then the dashboard opens at the block.
 */
export function MoveToDashboardModal({
  block,
  home,
  inherited,
  inherits,
  onTakeOut,
  onClose,
}: {
  block: ViewBlock;
  /** The collection it lists when it names none: its place's. */
  home: Collection;
  /** The filter it builds on there (its view's, or its item page's for its collection). */
  inherited: FilterRule[];
  /** Whose that filter is, for the text: "the view's", "the page's". */
  inherits: string;
  /** Takes it out of its place without asking; absent: it stays (a copy is made). */
  onTakeOut?(): Promise<void>;
  onClose(): void;
}) {
  const uid = useId();
  const open = useMountedDialog();
  const { repo, space, dashboards, spaceDashboards, reloadDashboards } = useStore();
  const openRelated = useOpenRelated();
  const choices: Choice[] = useMemo(() => [...spaceDashboards, NEW_DASHBOARD], [spaceDashboards]);
  const [choice, setChoice] = useState<Choice>(choices[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const moved = useMemo(() => movedBlock(block, home, inherited), [block, home, inherited]);
  const copy = !onTakeOut;

  async function move() {
    setSaving(true);
    try {
      let dashboardId = choice.id;
      if (!dashboardId) {
        dashboardId = newId();
        await repo.saveDashboard({ id: dashboardId, name: newDashboardName(dashboards.map((d) => d.name)), icon: null, description: "", spaceIds: [space.id] }, space.id);
      }
      // The space's tabs: copies of another space's are stored here first (all at once), as on the dashboard.
      let tabs = await repo.listDashboardViews(dashboardId, space.id);
      if (tabs.some((t) => t.virtual)) {
        await repo.storeDashboardViews(dashboardId, space.id);
        tabs = await repo.listDashboardViews(dashboardId, space.id);
      }
      const ts = now();
      const tab = tabToMoveTo(tabs) ?? {
        id: newId(), dashboardId, spaceId: space.id, name: FIRST_TAB_NAME, position: 0, isDefault: false,
        filters: [], blocks: [], editable: true, collapsed: NOTHING_COLLAPSED, createdAt: ts, updatedAt: ts,
      };
      await repo.saveDashboardView({ ...tab, blocks: [...tab.blocks, moved.block] });
      await onTakeOut?.();
      if (!choice.id) await reloadDashboards();
      onClose();
      openRelated(`/dashboards/${dashboardId}?view=${tab.id}&block=${moved.block.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  // At the window level (opened from a popover), inside the app root, which carries the theme and Carbon's tokens.
  return createPortal(
    <Modal
      open={open}
      size="xs"
      modalHeading="Move to a dashboard"
      primaryButtonText={copy ? "Copy" : "Move"}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={() => void move()}
    >
      <Stack gap={5}>
        {error && <InlineNotification kind="error" title="Could not move the block" subtitle={error} lowContrast hideCloseButton />}
        <p>
          {copy ? "This is the last block here, so it is copied" : "The block is moved"} to the end of the dashboard's starred tab (or its first)
          {inherited.length > 0 && `, with ${inherits} filter made part of its own`}. The dashboard opens at it.
        </p>
        <Dropdown<Choice>
          autoAlign
          size="sm"
          id={`${uid}-dashboard`}
          data-modal-primary-focus
          titleText="Dashboard"
          label="Dashboard"
          items={choices}
          selectedItem={choice}
          itemToString={(c) => c?.name ?? ""}
          itemToElement={(c) => <DashboardLabel choice={c} />}
          renderSelectedItem={(c) => <DashboardLabel choice={c} />}
          onChange={({ selectedItem }) => selectedItem && setChoice(selectedItem)}
        />
        {moved.pageRules && (
          <InlineNotification
            kind="warning"
            title="Rules on this item"
            subtitle="Its filter takes values from the page's item ($item): a dashboard has none, so those rules don't filter there as they do here."
            lowContrast
            hideCloseButton
          />
        )}
        {moved.reframed && (
          <InlineNotification
            kind="warning"
            title="Date period"
            subtitle={`The date period of ${inherits} filter now frames the block's own rules too: so it may show fewer items.`}
            lowContrast
            hideCloseButton
          />
        )}
      </Stack>
    </Modal>,
    document.querySelector(".app-root") ?? document.body,
  );
}
