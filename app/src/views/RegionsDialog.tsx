import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Checkbox, InlineLoading, Modal, Search, Stack, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@carbon/react";
import { useStore } from "../app/store";
import { regionValues, resultItems, type ChartOptions } from "../domain/chart";
import type { Collection } from "../domain/model";
import type { QueryResult } from "../domain/query";
import { matchKey, type ChartRegions, type Region } from "../domain/regions";
import { errorMessage } from "../ui/useConfirm";
import { useMountedDialog } from "../ui/useMountedDialog";
import { refLabelOf, type RefOptions } from "../ui/useReferenceOptions";
import { loadRegionMap, mapLabel, type RegionMap } from "./regionMaps";

// A choropleth's map's regions, from its Block settings ("Show regions"): every region's name (and
// English name) and code, what a value has to be to be it (domain/regions.ts), and how many of the
// block's items are in it; searchable, and narrowed to the regions with none.
// The values that are no region are listed above, as under the chart.

export function RegionsDialog({
  regions,
  options,
  collection,
  result,
  refs,
  onClose,
}: {
  regions: ChartRegions;
  options: ChartOptions;
  collection: Collection;
  /** The block's items (none: the regions alone). */
  result?: QueryResult;
  refs?: RefOptions;
  onClose(): void;
}) {
  const uid = useId();
  const open = useMountedDialog();
  const { repo } = useStore();
  const [map, setMap] = useState<RegionMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(false);

  useEffect(() => {
    let live = true;
    loadRegionMap(repo, regions).then(
      (m) => live && setMap(m),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [repo, regions]);

  const matched = useMemo(() => {
    if (!map || !result) return null;
    const input = { collection, items: resultItems(result), ctx: { refLabel: refLabelOf(refs ?? {}, "(deleted)") } };
    return regionValues(input, options, map.regions);
  }, [map, result, collection, refs, options]);
  const byRegion = useMemo(() => new Map((matched?.matches ?? []).map((m) => [m.region, m])), [matched]);

  const rows = useMemo(() => {
    const q = matchKey(query);
    const text = (r: Region) => matchKey([r.key, r.english, r.id].join(" "));
    return (map?.regions ?? [])
      .filter((r) => !onlyEmpty || !byRegion.has(r))
      .filter((r) => !q || text(r).includes(q))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [map, query, onlyEmpty, byRegion]);

  const notOnMap = matched && matched.unmatched.length > 0 ? matched.unmatched.map((u) => `${u.label} (${u.items})`).join(", ") : null;

  // At the window level (opened from the Block settings popover), inside the app root for the theme. Small, not
  // the dialogs' xs: a name, its English name, a code and a number don't fit an xs one.
  return createPortal(
    <Modal open={open} size="sm" passiveModal modalHeading={`Regions of ${mapLabel(regions.map)}`} onRequestClose={onClose} className="regions-dialog">
      <Stack gap={5}>
        <p className="helper">A value is a region when it is the region's name, English name or code (case, accents and punctuation aside).</p>
        {error && <p className="helper">{error}</p>}
        {!map && !error && <InlineLoading description="Loading the map…" />}
        {map && (
          <>
            {notOnMap && (
              <p className="helper regions-dialog__unmatched" title={`Not on the map: ${notOnMap}`}>
                Not on the map: {notOnMap}
              </p>
            )}
            {/* Carbon's Search stops every Escape (it clears its text): on an empty one, Escape closes the dialog. */}
            <div
              onKeyDownCapture={(e) => {
                if (e.key !== "Escape" || query) return;
                e.stopPropagation();
                onClose();
              }}
            >
              <Search size="sm" id={`${uid}-search`} labelText="Search regions" placeholder="Search regions" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {matched && <Checkbox id={`${uid}-empty`} labelText="Only regions without a value" checked={onlyEmpty} onChange={(_, { checked }) => setOnlyEmpty(checked)} />}
            <div className="regions-dialog__table">
              <Table size="sm">
                <TableHead>
                  <TableRow>
                    <TableHeader>Region</TableHeader>
                    <TableHeader>Code</TableHeader>
                    {matched && <TableHeader>Items</TableHeader>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => {
                    const name = r.english ? `${r.key} (${r.english})` : r.key;
                    return (
                      <TableRow key={r.key}>
                        <TableCell title={name}>{name}</TableCell>
                        <TableCell>{r.id}</TableCell>
                        {matched && <TableCell>{byRegion.get(r)?.items ?? ""}</TableCell>}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="helper">
              {rows.length} of {map.regions.length} regions{matched ? `, ${matched.matches.length} with a value` : ""}
            </p>
          </>
        )}
      </Stack>
    </Modal>,
    document.querySelector(".app-root") ?? document.body,
  );
}
