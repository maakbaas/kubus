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
