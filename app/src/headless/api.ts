// The HTTP API (/api/v1): every route is a thin translation onto one Repository method, so the
// API follows the GUI's rules. Documented on the Help page (help/api.md): keep the two in step.
//
// Collections are named by id, name or plural name, spaces by id or name (default: the default
// space), fields, components, views and item views by id or name, all in any case.

import { HttpError, json, readJson, Router, type ApiRequest } from "../../../shared/router";
import { MAX_FILE_BYTES } from "../../../shared/sync";
import type { Repository } from "../data/repository";
import { aiRequest } from "../domain/ai";
import type { Bookmark } from "../domain/bookmarks";
import { isComponentOutput, placeProblem, type Component } from "../domain/components";
import { fieldKinds } from "../domain/fieldKinds";
import { fileSrc, IMAGE_TYPES } from "../domain/files";
import { parseItemViews, type ItemView } from "../domain/fieldLayout";
import { canBeTitle, collectionDraft, isReferenceKind, newId, NO_TITLE, suggestPlural, type Collection, type CollectionDraft, type FieldDef, type FieldDraft, type Item, type ItemLabel } from "../domain/model";
import { applyQuery, filterValueProblem, isGrouped, operatorsFor, type FilterRule, type SortRule, type ViewQuery } from "../domain/query";
import { refLabelForSpace } from "../domain/refOptions";
import { DEFAULT_SPACE_ID, type Space } from "../domain/spaces";
import { blockQuery, defaultViewState, parseBlock, type CollectionView, type ViewBlock } from "../domain/views";
import { draftProblem } from "../domain/collectionDraft";
import { computeItems, loadWorld, type World } from "../domain/world";
import { fieldOf, itemOut, same, valuesIn, type ItemsExist } from "./values";

const MAX_JSON = 5 * 1024 * 1024;

type Body = Record<string, unknown>;

/** A request's body: a JSON object (none: an empty one). */
async function body(req: ApiRequest): Promise<Body> {
  const parsed = (await readJson(req, MAX_JSON)) ?? {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "The body must be a JSON object");
  return parsed as Body;
}

/** A text property of a body; `required` refuses an absent or blank one. */
function text(o: Body, key: string, required: true): string;
function text(o: Body, key: string, required?: false): string | undefined;
function text(o: Body, key: string, required = false): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `\`${key}\` is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `\`${key}\` must be text`);
  if (required && !v.trim()) throw new HttpError(400, `\`${key}\` can't be empty`);
  return v;
}

/** A repository refusal (a rule of the app, like deleting the only space) as 409. */
async function rule<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, e instanceof Error ? e.message : String(e));
  }
}

const collectionOf = (world: World, name: string): Collection => {
  const c =
    world.collections.find((x) => x.id === name) ??
    world.collections.find((x) => same(x.name, name) || same(x.pluralName, name));
  if (!c) throw new HttpError(404, `No collection “${name}”`);
  return c;
};

const spaceOf = (world: World, name: string | null | undefined): Space => {
  const key = name ?? DEFAULT_SPACE_ID;
  const s = world.spaces.find((x) => x.id === key) ?? world.spaces.find((x) => same(x.name, key));
  if (!s) throw new HttpError(404, `No space “${key}”`);
  return s;
};

const componentOf = (world: World, name: string): Component => {
  const c = world.components.find((x) => x.id === name) ?? world.components.find((x) => same(x.name, name));
  if (!c) throw new HttpError(404, `No component “${name}”`);
  return c;
};

const fieldOut = ({ collectionId: _collectionId, position: _position, ...field }: FieldDef) => field;

const collectionOut = (c: Collection, itemCount?: number) => ({
  id: c.id,
  name: c.name,
  pluralName: c.pluralName,
  icon: c.icon,
  description: c.description,
  spaces: c.spaceIds,
  titleField: c.titleField ?? null,
  ...(itemCount !== undefined && { itemCount }),
  fields: c.fields.map(fieldOut),
  itemViews: c.itemViews,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const viewOut = ({ collapsed: _collapsed, ...view }: CollectionView) => view;

const bookmarkOut = (b: Bookmark) => b;

/** A collection's title field as asked for: a text, number or date field (by id or name), "none", or null (the first text field with a value). */
function titleFieldIn(collection: Collection, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new HttpError(400, "`titleField` is a text, number or date field's id or name, \"none\" or null");
  if (raw === NO_TITLE) return NO_TITLE;
  const field = fieldOf(collection, raw);
  if (!canBeTitle(field)) throw new HttpError(400, `“${field.name}” isn't a text, number or date field: only one of those can be the title`);
  return field.id;
}

/** Field names in a block or filter list resolved to ids (against the collection it lists). */
/** Rules (filters, sorts) with their fields named by id or name; an item view's filter names fields of any of its blocks' collections. */
function resolveRules<R extends { fieldId: string }>(collections: Collection | Collection[], rules: unknown, what: string): R[] {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) throw new HttpError(400, `\`${what}\` must be a list`);
  const scope = Array.isArray(collections) ? collections : [collections];
  const fieldIdOf = (name: string) => {
    const owner = scope.find((c) => c.fields.some((f) => f.id === name || same(f.name, name))) ?? scope[0];
    return fieldOf(owner, name).id;
  };
  return rules.map((r) => {
    if (!r || typeof r !== "object" || typeof (r as { fieldId?: unknown }).fieldId !== "string") {
      throw new HttpError(400, `Each of \`${what}\` needs a \`fieldId\` (a field's id or name)`);
    }
    const join = (r as { join?: unknown }).join;
    if (join !== undefined && join !== "and" && join !== "or") throw new HttpError(400, "A filter's `join` is and or or");
    const { join: _join, ...rest } = r as { join?: unknown };
    return { id: newId(), ...rest, ...(join === "or" && { join }), fieldId: fieldIdOf((r as { fieldId: string }).fieldId) } as unknown as R;
  });
}

/** A list of rules given as JSON in the query string (`?filters=[…]`). */
function rulesParam(req: ApiRequest, name: string): unknown {
  const raw = req.query.get(name);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, `\`${name}\` must be a JSON list`);
  }
}

/** Filters to run now: each rule's operator one its field's kind has, and a value it can compare. */
function checkedFilters(collection: Collection, rules: FilterRule[]): FilterRule[] {
  return rules.map((rule) => {
    const field = collection.fields.find((f) => f.id === rule.fieldId)!;
    const operators = operatorsFor(field.kind).map((o) => o.id);
    const dated = field.kind === "date" || field.kind === "datetime";
    if (!operators.includes(rule.operator) && !(dated && rule.operator === "between")) {
      throw new HttpError(400, `“${field.name}” has no operator “${String(rule.operator)}”: ${[...operators, ...(dated ? ["between"] : [])].join(", ")}`);
    }
    const raw = rule.value as unknown;
    const value = raw === undefined || raw === null ? "" : String(raw);
    const problem = filterValueProblem(field, rule.operator, value.trim());
    if (problem) throw new HttpError(400, `“${field.name}”: ${problem}`);
    return { ...rule, value };
  });
}

/** A page of a list: `limit` (1 to `max`) and `offset` from the query string. */
function paging(req: ApiRequest, fallback: number, max: number) {
  const limit = Math.min(Math.max(Number(req.query.get("limit") ?? fallback) || fallback, 1), max);
  const offset = Math.max(Number(req.query.get("offset") ?? 0) || 0, 0);
  return { limit, offset };
}

function blockIn(world: World, own: Collection, raw: unknown): ViewBlock {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "A block must be an object");
  const o = raw as Body;
  const listed = typeof o.collectionId === "string" ? collectionOf(world, o.collectionId) : own;
  const layout = (o.layout && typeof o.layout === "object" ? o.layout : {}) as Body;
  const ids = (v: unknown) => (Array.isArray(v) ? v.map((n) => fieldOf(listed, String(n)).id) : v);
  const block = parseBlock({
    id: newId(),
    title: "",
    ...o,
    collectionId: listed === own ? null : listed.id,
    filters: o.filters === null || o.filters === undefined ? null : resolveRules<FilterRule>(listed, o.filters, "filters"),
    sort: resolveRules<SortRule>(listed, o.sort, "sort").map(({ fieldId, direction }) => ({ fieldId, direction })),
    groupBy: typeof o.groupBy === "string" ? fieldOf(listed, o.groupBy).id : null,
    layout: { ...layout, fields: layout.fields === null ? null : ids(layout.fields), hiddenLabels: ids(layout.hiddenLabels) ?? [] },
  });
  if (!block) throw new HttpError(400, "A block needs a `kind` (table, cards, map, component, markdown, …)");
  return block;
}

export function createApi(repo: Repository): Router {
  const world = () => loadWorld(repo);
  const computed = (w: World, collection: Collection, items: Item[], spaceId: string) => computeItems(repo, w, collection, items, spaceId);

  const exist =
    (w: World): ItemsExist =>
    async (collectionId, ids) => {
      const target = w.collections.find((c) => c.id === collectionId);
      if (!target) return ids;
      const found = new Set((await repo.listLabels(target, ids)).map((l) => l.id));
      return ids.filter((id) => !found.has(id));
    };

  /** An item by id with its collection; 404 when there is none (or it was deleted). */
  const itemOf = async (w: World, id: string) => {
    const collectionId = (await repo.collectionsOfItems([id])).get(id);
    const collection = w.collections.find((c) => c.id === collectionId);
    const item = collection && (await repo.getItem(collection, id));
    if (!collection || !item) throw new HttpError(404, `No item ${id}`);
    const [shown] = await computed(w, collection, [item], item.spaceId);
    return { collection, item: shown };
  };

  /** The item as it is now (after a write). */
  const itemAnswer = async (id: string, status = 200) => {
    const { collection, item } = await itemOf(await world(), id);
    return json(status, itemOut(collection, item));
  };

  /** A field as given, as the collection editor would make it (`existing`: the field it changes). */
  const fieldIn = (w: World, collection: Collection | null, o: Body, existing?: FieldDraft): FieldDraft => {
    const kind = (o.kind ?? existing?.kind) as FieldDef["kind"] | undefined;
    const kinds = Object.keys(fieldKinds);
    if (!kind || !kinds.includes(kind)) throw new HttpError(400, `\`kind\` must be one of ${kinds.join(", ")}`);
    if (existing && kind !== existing.kind) throw new HttpError(400, "A field's kind can't be changed");
    const name = (text(o, "name") ?? existing?.name ?? "").trim();
    if (!name) throw new HttpError(400, "`name` is required");
    let targetCollectionId = existing?.targetCollectionId ?? null;
    if (isReferenceKind(kind) && !existing) {
      const target = text(o, "targetCollection");
      if (!target) throw new HttpError(400, `A ${kind} field needs \`targetCollection\` (a collection's id or name)`);
      targetCollectionId = target === collection?.id || (collection && (same(target, collection.name) || same(target, collection.pluralName))) ? collection!.id : collectionOf(w, target).id;
    }
    // A component or AI field's component: a shared one (`component`) or its own (`code`, `output`, `frameRatio`).
    let componentId = existing?.componentId ?? null;
    let code = existing?.code ?? null;
    let output = existing?.output ?? null;
    let frameRatio = existing?.frameRatio ?? null;
    if (kind === "component" || kind === "ai") {
      const given = text(o, "component");
      if (given) {
        const component = componentOf(w, given);
        if (component.ai !== (kind === "ai")) throw new HttpError(400, kind === "ai" ? "An AI field needs a component asking AI" : "A component asking AI fills an AI field");
        componentId = component.id;
        code = null;
      } else if (o.code !== undefined) {
        code = text(o, "code") ?? "";
        componentId = null;
      }
      const shared = w.components.find((c) => c.id === componentId);
      if (o.output !== undefined) {
        if (existing && kind === "ai") throw new HttpError(400, "An AI field's `output` can't be changed");
        if (!isComponentOutput(o.output)) throw new HttpError(400, "`output` must be markdown, string, number, image or html");
        output = o.output;
      } else if (!existing || (code !== null && output === null)) {
        output = kind === "ai" ? (shared?.output ?? "string") : code !== null ? "markdown" : null;
      }
      if (o.frameRatio !== undefined) frameRatio = text(o, "frameRatio") ?? null;
    }
    const target = w.collections.find((c) => c.id === targetCollectionId);
    const choiceFilter =
      o.choiceFilter === undefined ? (existing?.choiceFilter ?? []) : target ? resolveRules<FilterRule>(target, o.choiceFilter, "choiceFilter") : [];
    return {
      id: existing?.id ?? newId(),
      name,
      kind,
      targetCollectionId,
      componentId,
      code,
      output,
      frameRatio,
      choiceFilter,
      toggleIcon: o.toggleIcon === undefined ? (existing?.toggleIcon ?? null) : (text(o, "toggleIcon") ?? null),
      strikeThrough: o.strikeThrough === undefined ? (existing?.strikeThrough ?? false) : o.strikeThrough === true,
    };
  };

  /** Saves a collection draft after the collection editor's checks. */
  const saveDraft = async (draft: CollectionDraft, spaceId: string) => {
    const problem = draftProblem(draft, (await world()).components);
    if (problem) throw new HttpError(400, problem);
    await rule(repo.saveCollection(draft, spaceId));
  };

  const spacesIn = (w: World, v: unknown): string[] | null => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v)) throw new HttpError(400, "`spaces` must be a list of spaces (or null: every space)");
    return v.map((s) => spaceOf(w, String(s)).id);
  };

  const collectionAnswer = async (id: string, status = 200) => {
    const w = await world();
    const c = collectionOf(w, id);
    return json(status, collectionOut(c));
  };

  /** A view of a collection by id or name, in any space (or the one given). */
  const viewOf = async (w: World, collection: Collection, name: string, space?: string) => {
    const spaces = space ? [spaceOf(w, space)] : w.spaces;
    for (const s of spaces) {
      const views = await repo.listViews(collection.id, s.id);
      const view = views.find((v) => v.id === name) ?? views.find((v) => same(v.name, name));
      if (view) return view;
    }
    throw new HttpError(404, `${collection.name} has no view “${name}”`);
  };

  const viewIn = (w: World, collection: Collection, o: Body, existing: CollectionView): CollectionView => ({
    ...existing,
    name: o.name === undefined ? existing.name : text(o, "name", true),
    filters: o.filters === undefined ? existing.filters : resolveRules<FilterRule>(collection, o.filters, "filters"),
    blocks:
      o.blocks === undefined
        ? existing.blocks
        : Array.isArray(o.blocks) && o.blocks.length > 0
          ? o.blocks.map((b) => blockIn(w, collection, b))
          : (() => {
              throw new HttpError(400, "`blocks` must be a list of at least one block");
            })(),
    editable: o.editable === undefined ? existing.editable : o.editable !== false,
  });

  const itemViewsIn = (w: World, collection: Collection, v: unknown): ItemView[] => {
    if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, "Send a list of at least one item view");
    const resolved = v.map((raw) => {
      const o = (raw ?? {}) as Body;
      const layout = (o.layout && typeof o.layout === "object" ? o.layout : {}) as Body;
      const blocks = Array.isArray(layout.blocks) ? layout.blocks.map((b) => blockIn(w, collection, b)) : [];
      const ids = (x: unknown) =>
        Array.isArray(x) ? x.map((n) => blocks.find((b) => b.id === n)?.id ?? fieldOf(collection, String(n)).id) : x;
      return {
        id: typeof o.id === "string" ? o.id : newId(),
        name: text(o, "name", true),
        isDefault: o.isDefault === true,
        collapsed: o.collapsed,
        layout: {
          editable: true,
          hideEmpty: false,
          ...layout,
          fields: layout.fields === undefined || layout.fields === null ? null : ids(layout.fields),
          filters: resolveRules<FilterRule>([collection, ...blocks.map((b) => (b.collectionId ? collectionOf(w, b.collectionId) : collection))], layout.filters, "layout.filters"),
          hiddenLabels: ids(layout.hiddenLabels) ?? [],
          blocks,
        },
      };
    });
    const views = parseItemViews(JSON.stringify(resolved));
    if (views.length !== resolved.length) throw new HttpError(400, "An item view isn't valid");
    if (!views.some((x) => x.isDefault)) views[0] = { ...views[0], isDefault: true };
    let seenDefault = false;
    return views.map((x) => {
      const isDefault = x.isDefault && !seenDefault;
      if (isDefault) seenDefault = true;
      return { ...x, isDefault };
    });
  };

  const componentIn = (o: Body, existing?: Component): Component => {
    const code = o.code === undefined ? (existing?.code ?? "") : (text(o, "code") ?? "");
    const ai = o.ai === undefined ? (existing?.ai ?? false) : o.ai === true;
    const output = o.output === undefined ? (existing?.output ?? (ai ? "string" : "markdown")) : o.output;
    if (!isComponentOutput(output)) throw new HttpError(400, "`output` must be markdown, string, number, image or html");
    const ts = new Date().toISOString();
    return {
      id: existing?.id ?? newId(),
      name: (o.name === undefined ? (existing?.name ?? "") : text(o, "name", true)).trim(),
      description: o.description === undefined ? (existing?.description ?? "") : (text(o, "description") ?? ""),
      code,
      output,
      ai,
      frameRatio: o.frameRatio === undefined ? (existing?.frameRatio ?? null) : (text(o, "frameRatio") ?? null),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
  };

  /**
   * A collection's items in a space, worked out, through a query (as a block runs it): a page of its
   * groups' items in order (an item in several groups is in each), and how many there are in all.
   */
  const queried = async (w: World, collection: Collection, spaceId: string, query: ViewQuery, limit: number, offset: number) => {
    const labels = new Map<string, ItemLabel[]>();
    const all = await computeItems(repo, w, collection, await repo.listItems(collection, spaceId), spaceId, labels);
    const refLabel = await refLabelForSpace(repo, collection, spaceId, w, labels);
    const result = applyQuery(collection, all, query, { refLabel });
    let skip = offset;
    let room = limit;
    const groups = result.groups.map((g) => {
      const shown = g.items.slice(Math.min(skip, g.items.length)).slice(0, room);
      skip = Math.max(0, skip - g.items.length);
      room -= shown.length;
      return { key: g.key, label: g.label, total: g.items.length, items: shown.map((i) => itemOut(collection, i)) };
    });
    const total = result.groups.reduce((n, g) => n + g.items.length, 0);
    return { grouped: isGrouped(result), groups: groups.filter((g) => g.items.length > 0), items: groups.flatMap((g) => g.items), total };
  };

  /** An AI field of an item, the item, and the fingerprint of its prompt as the item reads now. */
  const aiOf = async (id: string, name: string) => {
    const w = await world();
    const { collection, item } = await itemOf(w, id);
    const field = fieldOf(collection, name);
    if (field.kind !== "ai") throw new HttpError(400, `“${field.name}” isn't an AI field`);
    const refLabel = await refLabelForSpace(repo, collection, item.spaceId, w);
    const request = aiRequest(collection, field, item, refLabel, w.components);
    if ("problem" in request) throw new HttpError(409, request.problem);
    return { collection, item, field, hash: request.hash };
  };

  return (
    new Router()
      // Spaces
      .add("GET", "/api/v1/spaces", async () => json(200, await repo.listSpaces()))
      .add("POST", "/api/v1/spaces", async (req) => {
        const o = await body(req);
        const space = { id: newId(), name: text(o, "name", true).trim(), icon: text(o, "icon") ?? null };
        await repo.saveSpace(space);
        return json(201, spaceOf(await world(), space.id));
      })
      .add("PATCH", "/api/v1/spaces/{s}", async (req, { s }) => {
        const o = await body(req);
        const space = spaceOf(await world(), s);
        await repo.saveSpace({ id: space.id, name: o.name === undefined ? space.name : text(o, "name", true).trim(), icon: o.icon === undefined ? space.icon : (text(o, "icon") ?? null) });
        return json(200, spaceOf(await world(), space.id));
      })
      .add("DELETE", "/api/v1/spaces/{s}", async (_req, { s }) => {
        await rule(repo.deleteSpace(spaceOf(await world(), s).id));
        return json(200, { ok: true });
      })

      // Collections and fields
      .add("GET", "/api/v1/collections", async (req) => {
        const w = await world();
        const space = req.query.has("space") ? spaceOf(w, req.query.get("space")) : null;
        const counts = await repo.countItemsByCollection(space?.id ?? null);
        return json(200, w.collections.map((c) => collectionOut(c, counts[c.id] ?? 0)));
      })
      .add("GET", "/api/v1/collections/{c}", async (_req, { c }) => collectionAnswer(c))
      .add("POST", "/api/v1/collections", async (req) => {
        const o = await body(req);
        const w = await world();
        const name = text(o, "name", true).trim();
        if (w.collections.some((c) => same(c.name, name))) throw new HttpError(409, `There already is a collection “${name}”`);
        if (!Array.isArray(o.fields) || o.fields.length === 0) throw new HttpError(400, "`fields` must list at least one field");
        const id = newId();
        // Fields may refer to the collection itself (by its name) or to each other (by name).
        const self: Collection = { id, name, pluralName: text(o, "pluralName") ?? suggestPlural(name), icon: null, description: "", fields: [], itemViews: [], spaceIds: null, createdAt: "", updatedAt: "" };
        const fields: FieldDraft[] = [];
        for (const raw of o.fields as unknown[]) {
          const asCollection = { ...self, fields: fields.map((f, position) => ({ ...f, collectionId: id, position })) };
          fields.push(fieldIn(w, asCollection, (raw ?? {}) as Body));
        }
        await saveDraft(
          { id, name, pluralName: self.pluralName.trim(), icon: text(o, "icon") ?? null, description: text(o, "description") ?? "", spaceIds: spacesIn(w, o.spaces), fields },
          spaceOf(w, text(o, "space")).id,
        );
        return collectionAnswer(id, 201);
      })
      .add("PATCH", "/api/v1/collections/{c}", async (req, { c }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const draft = collectionDraft(collection);
        await saveDraft(
          {
            ...draft,
            name: o.name === undefined ? draft.name : text(o, "name", true).trim(),
            pluralName: o.pluralName === undefined ? draft.pluralName : text(o, "pluralName", true).trim(),
            icon: o.icon === undefined ? draft.icon : (text(o, "icon") ?? null),
            description: o.description === undefined ? draft.description : (text(o, "description") ?? ""),
            spaceIds: o.spaces === undefined ? draft.spaceIds : spacesIn(w, o.spaces),
            titleField: o.titleField === undefined ? draft.titleField : titleFieldIn(collection, o.titleField),
          },
          DEFAULT_SPACE_ID,
        );
        return collectionAnswer(collection.id);
      })
      .add("DELETE", "/api/v1/collections/{c}", async (_req, { c }) => {
        await rule(repo.deleteCollection(collectionOf(await world(), c).id));
        return json(200, { ok: true });
      })
      .add("POST", "/api/v1/collections/{c}/fields", async (req, { c }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const draft = collectionDraft(collection);
        const field = fieldIn(w, collection, o);
        await saveDraft({ ...draft, fields: [...draft.fields, field] }, DEFAULT_SPACE_ID);
        return collectionAnswer(collection.id, 201);
      })
      .add("PUT", "/api/v1/collections/{c}/fields/order", async (req, { c }) => {
        const order = await readJson(req, MAX_JSON);
        const w = await world();
        const collection = collectionOf(w, c);
        if (!Array.isArray(order)) throw new HttpError(400, "Send the fields as a list (ids or names), in their new order");
        const ids = order.map((n) => fieldOf(collection, String(n)).id);
        const draft = collectionDraft(collection);
        const rest = draft.fields.filter((f) => !ids.includes(f.id));
        const fields = [...ids.map((id) => draft.fields.find((f) => f.id === id)!), ...rest];
        await saveDraft({ ...draft, fields }, DEFAULT_SPACE_ID);
        return collectionAnswer(collection.id);
      })
      .add("PATCH", "/api/v1/collections/{c}/fields/{f}", async (req, { c, f }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const old = fieldOf(collection, f);
        const draft = collectionDraft(collection);
        const field = fieldIn(w, collection, o, draft.fields.find((x) => x.id === old.id));
        await saveDraft({ ...draft, fields: draft.fields.map((x) => (x.id === field.id ? field : x)) }, DEFAULT_SPACE_ID);
        return collectionAnswer(collection.id);
      })
      .add("DELETE", "/api/v1/collections/{c}/fields/{f}", async (_req, { c, f }) => {
        const w = await world();
        const collection = collectionOf(w, c);
        const old = fieldOf(collection, f);
        const draft = collectionDraft(collection);
        if (draft.fields.length === 1) throw new HttpError(409, "A collection always keeps a field: add another one first");
        await saveDraft({ ...draft, fields: draft.fields.filter((x) => x.id !== old.id) }, DEFAULT_SPACE_ID);
        return collectionAnswer(collection.id);
      })

      // Items
      .add("GET", "/api/v1/collections/{c}/items", async (req, { c }) => {
        const w = await world();
        const collection = collectionOf(w, c);
        const space = spaceOf(w, req.query.get("space"));
        const { limit, offset } = paging(req, 100, 1000);
        const filters = rulesParam(req, "filters");
        const sort = rulesParam(req, "sort");
        if (filters !== undefined || sort !== undefined) {
          const query: ViewQuery = {
            filters: checkedFilters(collection, resolveRules<FilterRule>(collection, filters, "filters")),
            sort: resolveRules<SortRule>(collection, sort, "sort").map(({ fieldId, direction }) => ({ fieldId, direction: direction === "desc" ? "desc" : "asc" })),
            groupBy: null,
          };
          const { items, total } = await queried(w, collection, space.id, query, limit, offset);
          return json(200, { items, total, limit, offset });
        }
        const page = await computed(w, collection, await repo.listItems(collection, space.id, { limit, offset }), space.id);
        const total = (await repo.countItemsByCollection(space.id))[collection.id] ?? 0;
        return json(200, { items: page.map((i) => itemOut(collection, i)), total, limit, offset });
      })
      .add("POST", "/api/v1/collections/{c}/items", async (req, { c }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const space = spaceOf(w, text(o, "space"));
        const values = await valuesIn(collection, o.values ?? {}, exist(w));
        if (collection.fields.some((f) => f.kind === "ai" && f.id in values)) throw new HttpError(400, "AI fields are generated: set them with PUT /api/v1/items/{id}/ai/{field}");
        const id = await rule(repo.createItem(collection, values, space.id));
        return itemAnswer(id, 201);
      })
      .add("GET", "/api/v1/items/{id}", async (_req, { id }) => {
        const w = await world();
        const { collection, item } = await itemOf(w, id);
        return json(200, itemOut(collection, item));
      })
      .add("PATCH", "/api/v1/items/{id}", async (req, { id }) => {
        const o = await body(req);
        const w = await world();
        const { collection } = await itemOf(w, id);
        await rule(repo.updateItem(collection, id, await valuesIn(collection, o.values ?? {}, exist(w))));
        return itemAnswer(id);
      })
      .add("DELETE", "/api/v1/items/{id}", async (_req, { id }) => {
        await itemOf(await world(), id);
        await repo.deleteItem(id);
        return json(200, { ok: true });
      })
      .add("POST", "/api/v1/items/{id}/move", async (req, { id }) => {
        const o = await body(req);
        const w = await world();
        const { collection } = await itemOf(w, id);
        const space = spaceOf(w, text(o, "space", true));
        if (collection.spaceIds && !collection.spaceIds.includes(space.id)) throw new HttpError(409, `${collection.pluralName} aren't shown in ${space.name}`);
        await repo.moveItem(id, space.id);
        return itemAnswer(id);
      })
      .add("PUT", "/api/v1/items/{id}/item-view", async (req, { id }) => {
        const o = await body(req);
        const w = await world();
        const { collection } = await itemOf(w, id);
        const given = o.itemView === null || o.itemView === undefined ? null : String(o.itemView);
        const view = given === null ? null : (collection.itemViews.find((v) => v.id === given) ?? collection.itemViews.find((v) => same(v.name, given)));
        if (given !== null && !view) throw new HttpError(404, `${collection.name} has no item view “${given}”`);
        await repo.pinItemView(id, view?.id ?? null);
        return itemAnswer(id);
      })
      .add("PUT", "/api/v1/items/{id}/ai/{f}", async (req, { id, f }) => {
        const o = await body(req);
        const { collection, field, hash } = await aiOf(id, f);
        const raw = o.value;
        let value: string | number | null;
        if (raw === null || raw === undefined) value = null;
        else if (field.output === "number") {
          if (typeof raw !== "number" || !Number.isFinite(raw)) throw new HttpError(400, `“${field.name}” takes a number`);
          value = raw;
        } else if (typeof raw === "string") value = raw;
        else throw new HttpError(400, `“${field.name}” takes text`);
        await repo.setGenerated(collection, id, field, value, hash);
        return itemAnswer(id);
      })
      .add("POST", "/api/v1/items/{id}/ai/{f}/accept", async (_req, { id, f }) => {
        const { collection, field, hash } = await aiOf(id, f);
        await repo.acceptEdit(collection, id, field, hash);
        return itemAnswer(id);
      })
      .add("GET", "/api/v1/search", async (req) => {
        const w = await world();
        const space = spaceOf(w, req.query.get("space"));
        const { limit } = paging(req, 50, 500);
        const shown = w.collections.filter((c) => c.spaceIds === null || c.spaceIds.includes(space.id));
        const hits = await repo.search(req.query.get("q") ?? "", shown, space.id, limit);
        // Computed per collection (not per hit), then back in the order of the hits.
        const out = new Map<string, ReturnType<typeof itemOut>>();
        for (const collection of shown) {
          const own = hits.filter((i) => i.collectionId === collection.id);
          if (own.length > 0) for (const item of await computed(w, collection, own, space.id)) out.set(item.id, itemOut(collection, item));
        }
        return json(200, hits.map((i) => out.get(i.id)!));
      })

      // Views
      .add("GET", "/api/v1/collections/{c}/views", async (req, { c }) => {
        const w = await world();
        const collection = collectionOf(w, c);
        return json(200, (await repo.listViews(collection.id, spaceOf(w, req.query.get("space")).id)).map(viewOut));
      })
      .add("GET", "/api/v1/collections/{c}/views/{v}/items", async (req, { c, v }) => {
        const w = await world();
        const collection = collectionOf(w, c);
        const view = await viewOf(w, collection, v, req.query.get("space") ?? undefined);
        const name = req.query.get("block");
        const block = name === null ? view.blocks[0] : (view.blocks.find((b) => b.id === name) ?? view.blocks.find((b) => same(b.title, name)));
        if (!block) throw new HttpError(404, `The view “${view.name}” has no block “${name}”`);
        const { limit, offset } = paging(req, 100, 1000);
        const result = await queried(w, collection, view.spaceId, blockQuery(view.filters, block), limit, offset);
        return json(200, {
          view: { id: view.id, name: view.name },
          block: { id: block.id, title: block.title, kind: block.kind },
          blocks: view.blocks.map((b) => ({ id: b.id, title: b.title, kind: b.kind })),
          ...(result.grouped ? { groups: result.groups } : { items: result.items }),
          total: result.total,
          limit,
          offset,
        });
      })
      .add("POST", "/api/v1/collections/{c}/views", async (req, { c }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const space = spaceOf(w, text(o, "space"));
        const existing = await repo.listViews(collection.id, space.id);
        const ts = new Date().toISOString();
        const base: CollectionView = {
          ...defaultViewState(null),
          id: newId(),
          collectionId: collection.id,
          spaceId: space.id,
          name: "",
          collapsed: { blocks: [], groups: {} },
          position: Math.max(-1, ...existing.map((v) => v.position)) + 1,
          isDefault: false,
          createdAt: ts,
          updatedAt: ts,
        };
        const view = viewIn(w, collection, { ...o, name: text(o, "name", true) }, base);
        await repo.saveView(view);
        return json(201, viewOut(await viewOf(w, collection, view.id, space.id)));
      })
      .add("PATCH", "/api/v1/collections/{c}/views/{v}", async (req, { c, v }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const old = await viewOf(w, collection, v, req.query.get("space") ?? undefined);
        await repo.saveView(viewIn(w, collection, o, old));
        return json(200, viewOut(await viewOf(w, collection, old.id, old.spaceId)));
      })
      .add("DELETE", "/api/v1/collections/{c}/views/{v}", async (req, { c, v }) => {
        const w = await world();
        const view = await viewOf(w, collectionOf(w, c), v, req.query.get("space") ?? undefined);
        await repo.deleteView(view.id);
        return json(200, { ok: true });
      })
      .add("PUT", "/api/v1/collections/{c}/default-view", async (req, { c }) => {
        const o = await body(req);
        const w = await world();
        const collection = collectionOf(w, c);
        const space = spaceOf(w, text(o, "space"));
        const view = o.view === null || o.view === undefined ? null : await viewOf(w, collection, String(o.view), space.id);
        await repo.setDefaultView(collection.id, space.id, view?.id ?? null);
        return json(200, (await repo.listViews(collection.id, space.id)).map(viewOut));
      })
      .add("GET", "/api/v1/collections/{c}/item-views", async (_req, { c }) => json(200, collectionOf(await world(), c).itemViews))
      .add("PUT", "/api/v1/collections/{c}/item-views", async (req, { c }) => {
        const list = await readJson(req, MAX_JSON);
        const w = await world();
        const collection = collectionOf(w, c);
        await repo.saveItemViews(collection.id, itemViewsIn(w, collection, list));
        return json(200, collectionOf(await world(), collection.id).itemViews);
      })

      // Bookmarks
      .add("GET", "/api/v1/bookmarks", async (req) => {
        const w = await world();
        return json(200, (await repo.listBookmarks(spaceOf(w, req.query.get("space")).id)).map(bookmarkOut));
      })
      .add("POST", "/api/v1/bookmarks", async (req) => {
        const o = await body(req);
        const w = await world();
        const space = spaceOf(w, text(o, "space"));
        const kind = o.kind;
        const target = text(o, "target", true);
        let collectionId: string;
        let label: string;
        if (kind === "item") {
          const { collection, item } = await itemOf(w, target);
          if (item.spaceId !== space.id) throw new HttpError(409, "The item is in another space");
          collectionId = collection.id;
          label = itemOut(collection, item).label;
        } else if (kind === "view") {
          const collection = collectionOf(w, text(o, "collection", true));
          const view = await viewOf(w, collection, target, space.id);
          collectionId = collection.id;
          label = `${collection.pluralName} / ${view.name}`; // as the app labels it
        } else throw new HttpError(400, "`kind` must be item or view");
        const targetId = kind === "item" ? target : (await viewOf(w, collectionOf(w, collectionId), target, space.id)).id;
        if ((await repo.listBookmarks(space.id)).some((b) => b.targetId === targetId)) throw new HttpError(409, "Already bookmarked");
        await repo.addBookmark(kind, collectionId, targetId, text(o, "label") ?? label, space.id);
        return json(201, (await repo.listBookmarks(space.id)).find((b) => b.targetId === targetId));
      })
      .add("PATCH", "/api/v1/bookmarks/{target}", async (req, { target }) => {
        const o = await body(req);
        await repo.relabelBookmark(target, text(o, "label", true));
        return json(200, { ok: true });
      })
      .add("DELETE", "/api/v1/bookmarks/{target}", async (req, { target }) => {
        await repo.removeBookmark(target, spaceOf(await world(), req.query.get("space")).id);
        return json(200, { ok: true });
      })

      // Components
      .add("GET", "/api/v1/components", async () => json(200, await repo.listComponents()))
      .add("GET", "/api/v1/components/{x}", async (_req, { x }) => json(200, componentOf(await world(), x)))
      .add("POST", "/api/v1/components", async (req) => {
        const component = componentIn(await body(req));
        if (!component.name) throw new HttpError(400, "`name` is required");
        await repo.saveComponent(component);
        return json(201, componentOf(await world(), component.id));
      })
      .add("PATCH", "/api/v1/components/{x}", async (req, { x }) => {
        const o = await body(req);
        const w = await world();
        const old = componentOf(w, x);
        const component = componentIn(o, old);
        // Fields showing it need a field component still, asking AI or not as before (as the component editor keeps it).
        const used = w.collections.some((c) => c.fields.some((f) => f.componentId === old.id));
        if (used && component.ai !== old.ai) throw new HttpError(409, "Fields show this component: whether it asks AI can't change");
        const problem = used ? placeProblem(component, "field") : null;
        if (problem) throw new HttpError(409, `Fields show this component: ${problem}`);
        await repo.saveComponent(component);
        return json(200, componentOf(await world(), component.id));
      })
      .add("DELETE", "/api/v1/components/{x}", async (req, { x }) => {
        const w = await world();
        await rule(repo.deleteComponent(componentOf(w, x).id, { withFields: req.query.get("withFields") === "true" }));
        return json(200, { ok: true });
      })

      // Files (their bytes come from the server directly: GET /api/v1/files/{id})
      .add("POST", "/api/v1/files", async (req) => {
        const mime = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!IMAGE_TYPES.includes(mime)) throw new HttpError(415, `Content-Type must be one of ${IMAGE_TYPES.join(", ")}`);
        const data = await req.body(MAX_FILE_BYTES);
        if (data.byteLength === 0) throw new HttpError(400, "The body is empty");
        const id = await repo.putFile(new Uint8Array(data), mime);
        return json(201, { id, src: fileSrc(id) });
      })
  );
}
