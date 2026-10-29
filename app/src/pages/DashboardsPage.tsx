import { useState } from "react";
import { useNavigate } from "react-router";
import { IconButton, InlineNotification, Link, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from "@carbon/react";
import { TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { dashboardIcon, newDashboardName, type Dashboard } from "../domain/dashboards";
import { newId } from "../domain/model";
import { CollectionIcon } from "../ui/collectionIcons";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { useTableSort } from "../ui/useTableSort";
import { LIST_MAIN, LIST_TABLE } from "../ui/listTable";
import { RowActions, ROW_BUTTON } from "../ui/RowActions";
import { FillTable } from "../views/TableView";


/**
 * The space's dashboards as a table (name with its icon opens it; description; spaces it is shown in; delete), plus
 * "New dashboard": made at once, in this space only, and opened with Dashboard settings open to name it.
 */
export function DashboardsPage() {
  const { repo, dashboards, spaceDashboards, spaces, space, reloadDashboards } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(errorMessage(e));
  const spacesOf = (d: Dashboard) => (d.spaceIds === null ? "All spaces" : spaces.filter((s) => d.spaceIds!.includes(s.id)).map((s) => s.name).join(", "));
  const { sort, header } = useTableSort<Dashboard, "name" | "description" | "spaces">({
    name: (d) => d.name,
    description: (d) => d.description,
    spaces: spacesOf,
  });

  async function create() {
    const id = newId();
    await repo.saveDashboard({ id, name: newDashboardName(dashboards.map((d) => d.name)), icon: null, description: "", spaceIds: [space.id] }, space.id);
    await reloadDashboards();
    navigate(`/dashboards/${id}`, { state: { rename: true } });
  }

  async function remove(d: Dashboard) {
    if (!(await confirm({ title: `Delete dashboard “${d.name}”?`, body: "Its tabs go too, in every space. Items are not affected." }))) return;
    await repo.deleteDashboard(d.id);
  }

  return (
    <>
      <PageHeader
        title="Dashboards"
        subtitle="Pages of blocks of any collections: tables, cards, charts, maps and components in tabs, with one filter for all of them."
        actions={<NewButton label="New dashboard" onClick={() => create().catch(fail)} />}
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {spaceDashboards.length === 0 ? (
        <Tile className="empty-state">
          <p>No dashboards yet.</p>
        </Tile>
      ) : (
        <FillTable>
          <Table size="sm" className={LIST_TABLE}>
            <TableHead>
              <TableRow>
                <TableHeader className={LIST_MAIN} {...header("name")}>Name</TableHeader>
                <TableHeader {...header("description")}>Description</TableHeader>
                {spaces.length > 1 && <TableHeader {...header("spaces")}>Spaces</TableHeader>}
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {sort(spaceDashboards).map((d) => (
                <TableRow key={d.id}>
                  <TableCell className={LIST_MAIN}>
                    <span className="icon-label">
                      <CollectionIcon name={dashboardIcon(d)} />
                      <Link className="icon-label__text" href={`#/dashboards/${d.id}`}>
                        {d.name}
                      </Link>
                    </span>
                  </TableCell>
                  <TableCell>{d.description}</TableCell>
                  {spaces.length > 1 && <TableCell>{spacesOf(d)}</TableCell>}
                  <RowActions>
                    <IconButton {...ROW_BUTTON} label={`Delete ${d.name}`} onClick={() => remove(d).catch(fail)}>
                      <TrashCan />
                    </IconButton>
                  </RowActions>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </FillTable>
      )}
      {dialog}
    </>
  );
}
