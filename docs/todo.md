# To do

Planned changes, roughly in order. Remove an item once it is done (the docs then describe it).

## Components: drop variables, AI as a component

1. **Remove `$variables`.** `$item` already reads the item directly; variables are only an
   indirection for reusing a component across collections with different field names, and Write
   with AI writes code for one collection anyway. Generic reuse stays possible (`{{ $item }}`,
   `$fields`, `$item.Pages ?? $item.Length`); block parameters (which field to sum, a threshold)
   go in the code.
   - Delete `params` / `parseParams`, `ComponentArg`, `componentArgs`, `argValue` / `blockArgValue`,
     `ui/ComponentArgInput.tsx`, the per-variable test values in the component editor, and the
     variable mapping in the field modal and block settings.
   - Kinds: field (`$item`), block (`$items` / `$groups` / `$fields` / `$all`), static (neither:
     blocks only, as a field it would be a constant).
   - Schema: drop `components.params` and `fields.component_args` in place (`schema.sql`,
     `server/schema.sql`, `shared/sync.ts`).
   - Update the Help text (`app/src/help/components.md`), `docs/features.md`, CLAUDE.md.

2. **AI is a switch on a component, not a field type.** With variables gone, an AI prompt is
   exactly a field component (`{{ }}` text over `$item`); only what happens to the rendered text
   differs (shown vs. sent to the model and the reply stored).
   - Component gets an **"Ask AI"** Toggle beside Output (a boolean column, e.g. `ai`), not extra
     output choices. While on: Output offers only Text / Number / Markdown (Image / HTML hidden; a
     component set to one switches to Markdown); the preview shows the rendered prompt ("Sent to
     the model") with a "Try" button that asks the model once; the AI rules (no `$now`, no AI
     fields in `$item`, not a block) are one more `placeProblem` case; Write with AI writes a
     prompt instead of code.
   - `AiOutput` folds into `ComponentOutput`; the generation machinery (`domain/ai.ts`, `app/ai.ts`,
     backfill, fingerprints, user overrides) keeps working per field id, for component fields
     whose component asks AI.
   - Remove the "AI" field type: an AI field is a Component field with an AI component. The field
     type list describes Component as "computed from code, or written by AI".
   - One-off prompts go through the existing **New component** button in the field modal
     (`NewComponentModal`), which gets the same Ask AI toggle (code helper reads "Prompt") — the
     same path for code and prompts. Keep the button; a Carbon Dropdown has no action items.
   - Components list: an "AI" tag next to the kind (and in the field modal's picker). Choosing an
     AI component in the field modal shows that values are generated and stored, for how many items.
   - Editing an AI component regenerates values everywhere it is used: the "change applies
     everywhere" confirmation names that cost.
   - Existing AI fields (`fields.ai_prompt`, `ai_output`): convert each to a component at open
     (like `RENAMES`), or accept a wipe.
   - "Code lives only in components" then has no exception: update CLAUDE.md and the Help text.

## Collection setup: field settings

3. **Visual hierarchy for a field's own settings** (`pages/CollectionEditorPage.tsx`, the field rows).
   Today a field with extra settings (reference target, choice filter, toggle icon, component and
   its variables, AI prompt and output, strike through) just gets more controls appended in its
   row. Design a clear hierarchy instead: the field's name and type as the row, its settings
   grouped beneath it as a subordinate, indented part of that field (Carbon only, spacing scale,
   on the row's left edge rules of the design checks).
   - Long inputs (an AI prompt, or whatever replaces it after items 1–2) get the full width, not
     a cell in the row.
   - Strike through ("Strike through when checked") is misaligned with the other controls: fix it
     in the same pass.

## Strike through

4. **Strike through the item, not only the checkbox.** A checkbox field with strike through, when
   checked, should strike the item wherever it is listed: its title on cards and in table rows,
   and in other collection blocks (component blocks get it as data, e.g. the field is in `$items`;
   decide whether they show it themselves). Today only the checkbox's own label and checklist
   rows are struck (`checklist-row__done--struck` in `ui/FieldInput.tsx`, `ui/ListField.tsx`).

## Filters

5. **`{{ }}` in filter values, as raw text.** Expected: `{{ 1 == 1 }}` as a checkbox filter's value
   matches checked items (asked for before). Decided: filter values may hold `{{ }}` sections, typed
   and shown as raw text (no chips/pills). This is an exception to "code lives only in components":
   update CLAUDE.md, `docs/features.md`, the Help text and the AI rules.
   - History: before fcef991 a filter value's `{{ }}` ran only for blocks on item pages, over the
     page's item (`resolvePageValues` with `evalText`); fcef991 removed it (filter values became
     data) and added page-item values by name ("This Book's Year"). Bring the rendering back for
     every filter, not only on item pages.
   - What a section can read: `$now` (relative dates); on an item page the page's item as `$item`
     (elsewhere `$item` is null, or a problem shown at the input). A section's result is the
     value as if typed (`true` / a number / a date text), compared by the field's operator.
   - Today a checkbox "is" compares the text to `true` (`domain/query.ts`, `matches`), so
     `{{1==1}}` silently matches *unchecked* items. A value that doesn't fit (not true / false, not
     a number, a failing section) is a problem shown at the input, never a silent match.

## Local components

6. **Local components: one paradigm for every place that takes a component.** Proposed earlier,
   never built (fcef991 took the other route: Markdown blocks are plain GFM; "Save as component"
   makes a shared component, static since the text uses no `$` names). Design it together with
   items 1–2.
   - **Item values never hold `{{ }}`**: removed on purpose, stays that way.
   - **The rule**: wherever a component is used, either pick a shared one or write one in place.
     Written in place = a *local* component, owned by that place: same table, code language and
     editor; an owner reference (e.g. `components.owner_id` + what it is) marks it local; deleting
     the owner deletes it. Local ones have no name to give (shown as their place).
   - **Kinds per place stay as they are** (`placeProblem`):
     - component field: field or static (a one-off formula or AI prompt over `$item`; the field
       modal edits it in place; `NewComponentModal` / the "New component" button become this);
     - component block: block or static;
     - Markdown block: static only. A Markdown block then *is* a block with a local static
       Markdown component (consider merging the two block types).
   - **Components page** lists local ones too, with where they are used ("Used in: Books › Reading
     time", "Dune › Notes"), filterable apart from the shared ones.
   - **Promote to shared** (the general form of today's "Save as component", in every place):
     gives it a name, and it can then be picked elsewhere. Editing a shared one asks first
     (applies everywhere; for AI components: regenerates everywhere); editing a local one doesn't.
   - Deciding between picking and writing in place must stay one simple control in the field modal
     and block settings (see item 3's hierarchy), not two parallel sets of inputs.

## Cards

7. **"Show as a list when narrow": the only thing that changes a card's layout, and only when on**
   (`views/CardsView.tsx`, `.item-card*` in `styles.css`). The column count always just follows the
   card width (one per row is fine when that is what fits).
   - Today: the setting only moves the cover to the left (`item-card--cover-left`), keyed to
     `listNarrow && columns === 1` (so also in a wide pane with a large card width: not about
     narrow), and it forces one column below `STACK_BELOW_REM`. Labels sit beside their values by
     default either way; separately, any card under 16rem stacks labels above values
     (`@container (max-width: 16rem)`), setting or not.
   - Off: the default card (cover on top, labels beside values) at every width and breakpoint: no
     forced single column, no list rows, and the 16rem stacking goes (or moves under the setting).
     Without it a very narrow card must still not overflow: labels wrap or ellipsize (readable
     whole via their title).
   - On: below the narrow width (`STACK_BELOW_REM`, as tables restack) one card per row as list
     rows (cover on the left, text beside it); above it, the default card.
   - Confirm in the app nothing else changes card styling with the setting off (reported as
     "happens anyway").
