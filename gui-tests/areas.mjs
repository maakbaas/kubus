// Which GUI suites cover which parts of the app: `npm run test:gui -- --changed` runs the suites of
// the files changed since origin/main (committed or not), with --smoke only their smoke tests.
// Each entry is a path pattern and the suites (by number) that test it; a changed file takes every
// entry it matches. A file under app/ or shared/ that matches none takes every suite (unknown
// reach); files outside them (server/, docs/, desktop/) take none. The pages matrix (suites 01 and 35-39: every page at every
// size) runs whenever anything in the app changed. Keep this current when adding a suite or a
// part of the app (docs/testing.md).

/** The parts of the pages matrix (every page at every size): 01 typical, 35 long, 36 unbroken, 37 unicode, 38 short, 39 the rest. */
const PAGES_MATRIX = [1, 35, 36, 37, 38, 39];

/** Anything that changes every page: all suites. */
const EVERYTHING = "all";

export const AREAS = [
  // Not in the GUI: the headless device, unit tests and their helpers.
  [/^app\/src\/(headless\/|test\/)|\.test\.tsx?$|^app\/vite\.headless\.config\.ts$/, []],

  // Shared by every page: styles, fonts, the entry point, the build, the suite's own library.
  [/^app\/(index\.html|vite\.config\.ts|src\/(styles\.css|fonts\.css|main\.tsx))$/, EVERYTHING],
  [/^(package-lock\.json|package\.json)$/, EVERYTHING],
  [/^gui-tests\/(run\.mjs|areas\.mjs|lib\/)/, EVERYTHING],
  [/^app\/src\/ui\/(PageHeader|SectionHeader|NotFound|useConfirm|useMountedDialog|escapeThroughDropdowns|useMediaQuery|collectionIcons|IconPicker)/, EVERYTHING],

  // A suite file: itself.
  [/^gui-tests\/suites\/(\d\d)-/, "self"],
  [/^gui-tests\/baselines\//, [21]],

  // The shell: workspace, tabs, side nav, spaces, search.
  [/^app\/src\/(workspace\/|app\/(App|NavTree|routes|store)\.tsx|app\/useRemotes\.ts|ui\/(SpaceSwitcher|SearchBar|TabMenu|BookmarkButton|RelatedLink|ItemLink|useLinkTarget|NewButton))/, [2, 11, 12, 29, 30, 33]],
  [/^app\/src\/pages\/(SearchPage|BookmarksPage|SpacesPage)/, [2, 7, 19, 29, 30]],

  // Item pages and editing values in place.
  [/^app\/src\/(pages\/(ItemPage|NewItemPage)|ui\/(FieldInput|ListField|ToggleInput|TagChip|RefCombo|editStart|useBuffered|useReferenceOptions|Highlight))/, [4, 12, 19, 27, 31, 32]],
  [/^app\/src\/ui\/(MarkdownEditor|LinkPicker|LinkTargetList|MarkdownView|codeHighlight)/, [8, 19, 34]],
  [/^app\/src\/(ui\/(Lightbox|images|thumbnails)|domain\/files)/, [16]],

  // Collection views and their blocks.
  [/^app\/src\/views\/(TableView|cells)|^app\/src\/ui\/(RowActions|useTableSort)/, [5, 12, 25, 32]],
  [/^app\/src\/views\/CardsView/, [6, 19, 22, 25]],
  [/^app\/src\/(views\/(Chart|Stat|chartSpec|HeightSlider)|domain\/chart)/, [24]],
  [/^app\/src\/(views\/|pages\/CollectionPage|domain\/(views|query|filterTree|datePeriod))/, [5, 6, 10, 22, 25, 32]],
  [/^app\/src\/(views\/(MapView|ComponentBlock|MarkdownBlock)|domain\/geo|ui\/MapSettings)/, [25]],
  // Filter, sort, group, date period (rows asserted), a reference field's Choices.
  [/^app\/src\/(views\/(QueryEditor|DatePeriodFilter|BlockView|TableView|CardsView)|domain\/(query|filterTree|datePeriod|views)|pages\/(CollectionPage|ItemPage)|ui\/ChoiceFilterEditor)/, [26]],
  // The collection view's filter bar (Show filter bar): its setting, Filter button and date period.
  [/^app\/src\/(views\/(FilterBar|DatePeriodFilter)|domain\/(datePeriod|views)|pages\/CollectionPage|data\/sqlite\/SqliteRepository)/, [44]],
  [/^app\/src\/ui\/(ToolbarPopover|panelRoom|OverflowBar)|^app\/src\/platform\/keyboardInset/, [10, 14, 20]],

  // Backlinks: the virtual collection of item-page blocks and the item links behind it.
  [/^app\/src\/(domain\/(backlinks|sources|views)|views\/(useBacklinks|BlockView|useItemActions|itemActions|cells|TableView|CardsView)|pages\/ItemPage|data\/sqlite\/SqliteRepository|data\/sync\/SyncEngine)/, [43]],

  // Collections, fields, components.
  [/^app\/src\/(pages\/(CollectionEditorPage|CollectionsPage|RemotesPage)|ui\/(SourceSettings|FieldEditor|FieldModal|FieldOrderEditor|FieldSettings|fieldKindIcons|ChoiceFilterEditor)|domain\/(collectionDraft|fieldKinds|fieldLayout))/, [7, 17, 22, 27, 29]],
  [/^app\/src\/ui\/useReorder/, [17]],
  [/^app\/src\/(pages\/(ComponentEditorPage|ComponentsPage)|ui\/(Component|PromoteComponentModal|promoteLocal|ValueSourceSwitch|frameFonts)|domain\/(components|componentWriter))/, [7, 19, 22, 31, 32, 33]],

  // AI, sync, live changes, settings.
  [/^app\/src\/(app\/(ai|aiBackfill|aiScan|useAi|AiBackfillRunner)|ui\/(Ai|WriteWithAi)|domain\/ai|platform\/llm)/, [15, 31]],
  [/^app\/src\/(data\/sync\/|ui\/(SyncSettings|ServerConnection|ApiTokens|SyncStatusButton|ServerReplaced|OutdatedNotice))/, [13, 18, 33]],
  [/^app\/src\/(app\/(useDataChanges|itemCache|useItems|useItemCounts|useLinks)|views\/useCollectionData)/, [12, 13]],
  [/^app\/src\/(pages\/SettingsPage|ui\/(ConnectionSettings|useServerSettings|SourceSettings|localPrefs))/, [7, 18]],
  [/^app\/src\/(pages\/SettingsPage|platform\/download|ui\/(AiSettings|BackupSettings|MapSettings|ServerConnection|ConnectionSettings|ApiTokens|SyncSettings|SourceSettings|useServerSettings)|app\/mapStyle|data\/remote\/client|data\/sync\/SyncEngine)/, [28]],
  [/^app\/src\/(pages\/HelpPage|help\/)/, [...PAGES_MATRIX, 30]],
];

/** The suite numbers (or "all") that cover these changed files; [] when none touches the app's GUI. */
export function suitesFor(files) {
  const suites = new Set();
  let all = false;
  for (const file of files) {
    const hits = AREAS.map(([pattern, which]) => [pattern.exec(file), which]).filter(([m]) => m);
    if (hits.some(([, which]) => Array.isArray(which) && which.length === 0)) continue; // not in the GUI
    if (hits.length === 0) {
      if (/^(app|shared)\//.test(file)) all = true; // unknown reach
      continue;
    }
    for (const [m, which] of hits) {
      if (which === EVERYTHING) all = true;
      else if (which === "self") suites.add(Number(m[1]));
      else for (const n of which) suites.add(n);
    }
    if (/^(app|shared)\//.test(file)) for (const n of PAGES_MATRIX) suites.add(n);
  }
  return all ? "all" : [...suites].sort((a, b) => a - b);
}
