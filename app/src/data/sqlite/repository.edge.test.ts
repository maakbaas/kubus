// @vitest-environment node
// The Repository contract beyond the basics (repository.test.ts): refusals, soft deletes, AI values,
// files and their clean-up, bookmarks, item views, remote collections. Without sync or the HTTP API.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeEngine } from "../../test/engine";
import { bytes, device } from "../../test/fakeServer";
import type { Component } from "../../domain/components";
import type { ItemView } from "../../domain/fieldLayout";
import { collectionDraft, newId, type Collection, type FieldDef, type FieldKind } from "../../domain/model";
import { rowItemId } from "../../domain/sources";
import type { DataChange } from "../repository";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

type Repo = Awaited<ReturnType<typeof device>>;
let repo: Repo;
let changes: DataChange[];

beforeEach(async () => {
  repo = await device({ connect: false });
  changes = [];
  repo.subscribe((c) => changes.push(c));
});

const field = (name: string, kind: FieldKind = "string", over: Partial<FieldDef> = {}): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0, ...over,
});

/** Saves a collection with these fields (in this order) in the default space; returns it as listed. */
async function collection(name: string, fields: FieldDef[], spaceId = "default"): Promise<Collection> {
  const id = newId();
  await repo.saveCollection({ id, name, pluralName: `${name}s`, icon: null, description: "", spaceIds: null, fields: fields.map((f, i) => ({ ...f, position: i })) }, spaceId);
  return (await repo.listCollections()).find((c) => c.id === id)!;
}

const titles = (items: { values: Record<string, unknown> }[], c: Collection) => items.map((i) => i.values[c.fields[0].id]);

/** The database under the repository, for what the Repository can't tell (tombstones, marks). */
const db = () => (repo as unknown as { db: { select<R>(q: string, b: unknown[]): Promise<R[]>; write(s: unknown[]): Promise<void> } }).db;
const sql = <T = Record<string, unknown>>(query: string, bind: (string | number | null)[] = []) => db().select<T>(query, bind);

const component = (name: string, over: Partial<Component> = {}): Component => {
  const ts = new Date().toISOString();
  return { id: newId(), name, description: "", code: "{{ $item.Title }}", output: "markdown", frameRatio: null, ai: false, createdAt: ts, updatedAt: ts, ...over };
};

describe("the default space", () => {
  it("can be renamed (it gets its row then), and stays first", async () => {
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.saveSpace({ id: "default", name: "Home", icon: "Home" });
    expect((await repo.listSpaces()).map((s) => [s.id, s.name, s.icon])).toEqual([["default", "Home", "Home"], ["work", "Work", null]]);
  });

  it("can be deleted once another space exists: gone with its items, and not listed again", async () => {
    const book = await collection("Book", [field("Title")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const here = await repo.createItem(book, { [book.fields[0].id]: "Here" }, "default");
    const there = await repo.createItem(book, { [book.fields[0].id]: "There" }, "work");
    await repo.deleteSpace("default");
    expect((await repo.listSpaces()).map((s) => s.id)).toEqual(["work"]);
    expect(await repo.getItem(book, here)).toBeNull();
    expect((await repo.getItem(book, there))?.spaceId).toBe("work");
    await expect(repo.deleteSpace("work")).rejects.toThrow(/only space/);
  });

  it("is refused deletion while it is the only space", async () => {
    await expect(repo.deleteSpace("default")).rejects.toThrow("The only space can't be deleted.");
  });
});

describe("deleting a space", () => {
  it("soft-deletes its items, views and bookmarks, and reports each affected collection", async () => {
    const book = await collection("Book", [field("Title")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const [all] = await repo.listViews(book.id, "default");
    const ts = new Date().toISOString();
    await repo.saveView({ ...all, id: newId(), spaceId: "work", name: "Work view", createdAt: ts, updatedAt: ts });
    const id = await repo.createItem(book, {}, "work");
    await repo.addBookmark("item", book.id, id, "It", "work");
    changes = [];
    await repo.deleteSpace("work");
    expect(changes).toEqual([
      { scope: "spaces" }, { scope: "bookmarks" }, { scope: "items", collectionId: book.id }, { scope: "views", collectionId: book.id },
    ]);
    expect(await repo.listViews(book.id, "work")).toEqual([]);
    expect((await repo.listViews(book.id, "default")).map((v) => v.name)).toEqual(["All"]);
    // Soft: the rows stay as tombstones, which is what sync sends.
    expect(await sql("SELECT count(*) AS n FROM items WHERE id = ?1 AND deleted_at IS NOT NULL", [id])).toEqual([{ n: 1 }]);
    expect(await sql("SELECT count(*) AS n FROM spaces WHERE id = 'work' AND deleted_at IS NOT NULL")).toEqual([{ n: 1 }]);
  });

  it("marks the files its items used as unused", async () => {
    const photo = await collection("Photo", [field("Title"), field("Image", "image")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const file = await repo.putFile(bytes("pixels"), "image/png");
    await repo.createItem(photo, { [photo.fields[1].id]: file }, "work");
    expect(await sql("SELECT unused_since FROM files WHERE id = ?1", [file])).toEqual([{ unused_since: null }]);
    await repo.deleteSpace("work");
    expect((await sql<{ unused_since: string | null }>("SELECT unused_since FROM files WHERE id = ?1", [file]))[0].unused_since).not.toBeNull();
  });
});

describe("saving a collection", () => {
  it("refuses a draft the collection editor would refuse, and changes nothing", async () => {
    const draft = (name: string, fields: FieldDef[]) => ({ id: newId(), name, pluralName: `${name}s`, icon: null, description: "", spaceIds: null, fields });
    await expect(repo.saveCollection(draft("", [field("A")]), "default")).rejects.toThrow("Singular name is required");
    await expect(repo.saveCollection(draft("Book", []), "default")).rejects.toThrow("at least one field");
    await expect(repo.saveCollection(draft("Book", [field("A"), field("a")]), "default")).rejects.toThrow(/Duplicate field name/);
    await expect(repo.saveCollection(draft("Book", [field("Ref", "item")]), "default")).rejects.toThrow(/Choose a collection/);
    expect(await repo.listCollections()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("keeps a field's kind and an AI field's output once created, whatever the draft says", async () => {
    const note = await collection("Note", [field("Text"), field("Count", "number"), field("Summary", "ai", { code: "Summarize {{ $item.Text }}", output: "string" })]);
    const [, count, summary] = note.fields;
    await repo.saveCollection({ ...collectionDraft(note), fields: [note.fields[0], { ...count, kind: "string" }, { ...summary, output: "number" }] }, "default");
    const saved = (await repo.listCollections()).find((c) => c.id === note.id)!;
    expect(saved.fields.map((f) => [f.kind, f.output])).toEqual([["string", null], ["number", null], ["ai", "string"]]);
  });

  it("stores a component field's shared component or its own code", async () => {
    const shared = component("Badge");
    await repo.saveComponent(shared);
    const thing = await collection("Thing", [field("Title"), field("Shown", "component", { componentId: shared.id }), field("Own", "component", { code: "{{ $item.Title }}", output: "number" })]);
    expect(thing.fields.slice(1).map((f) => [f.componentId, f.code, f.output])).toEqual([[shared.id, null, null], [null, "{{ $item.Title }}", "number"]]);
    await repo.saveCollection({ ...collectionDraft(thing), fields: [thing.fields[0], { ...thing.fields[1], componentId: null, code: "{{ $item.Title }}!", output: "html", frameRatio: "4/3" }, thing.fields[2]] }, "default");
    const saved = (await repo.listCollections()).find((c) => c.id === thing.id)!;
    expect([saved.fields[1].componentId, saved.fields[1].code, saved.fields[1].output, saved.fields[1].frameRatio]).toEqual([null, "{{ $item.Title }}!", "html", "4/3"]);
  });

  it("keeps a reference field's choice filter, a checkbox's toggle icon and strike-through; other kinds have none", async () => {
    const person = await collection("Person", [field("Name")]);
    const filter = { id: "r1", fieldId: person.fields[0].id, operator: "contains" as const, value: "A" };
    const task = await collection("Task", [
      field("Title"),
      field("Owner", "item", { targetCollectionId: person.id, choiceFilter: [filter] }),
      field("Done", "checkbox", { toggleIcon: "Star", strikeThrough: true }),
      field("Text", "string", { strikeThrough: true, choiceFilter: [filter] }),
    ]);
    const [, owner, done, text] = task.fields;
    expect(owner.choiceFilter).toEqual([filter]);
    expect([done.toggleIcon, done.strikeThrough]).toEqual(["Star", true]);
    expect(text.choiceFilter).toEqual([]);
    expect(text.strikeThrough).toBe(false);
  });

  it("takes a title field only when it can be one, or none", async () => {
    const task = await collection("Task", [field("Title"), field("Done", "checkbox")]);
    const titled = async (titleField: string | null) => {
      await repo.saveCollection({ ...collectionDraft(task), titleField }, "default");
      return (await repo.listCollections()).find((c) => c.id === task.id)!.titleField;
    };
    expect(await titled(task.fields[1].id)).toBeNull(); // a checkbox can't be a title
    expect(await titled("nonsense")).toBeNull();
    expect(await titled("none")).toBe("none");
    expect(await titled(task.fields[0].id)).toBe(task.fields[0].id);
  });

  it("marks a removed field's files unused and soft-deletes the field", async () => {
    const photo = await collection("Photo", [field("Title"), field("Image", "image")]);
    const file = await repo.putFile(bytes("pixels"), "image/png");
    await repo.createItem(photo, { [photo.fields[1].id]: file }, "default");
    await repo.saveCollection({ ...collectionDraft(photo), fields: [photo.fields[0]] }, "default");
    expect((await sql<{ unused_since: string | null }>("SELECT unused_since FROM files WHERE id = ?1", [file]))[0].unused_since).not.toBeNull();
    expect(await sql("SELECT count(*) AS n FROM fields WHERE id = ?1 AND deleted_at IS NOT NULL", [photo.fields[1].id])).toEqual([{ n: 1 }]);
  });

  it("limits a collection to some spaces, and back to all", async () => {
    const note = await collection("Note", [field("Text")]);
    await repo.saveCollection({ ...collectionDraft(note), spaceIds: ["default", "work"] }, "default");
    expect((await repo.listCollections())[0].spaceIds).toEqual(["default", "work"]);
    await repo.saveCollection({ ...collectionDraft(note), spaceIds: null }, "default");
    expect((await repo.listCollections())[0].spaceIds).toBeNull();
  });
});

describe("deleting a collection", () => {
  it("soft-deletes its items, fields and views, and hides its bookmarks", async () => {
    const book = await collection("Book", [field("Title")]);
    const id = await repo.createItem(book, {}, "default");
    await repo.addBookmark("item", book.id, id, "It", "default");
    changes = [];
    await repo.deleteCollection(book.id);
    expect(changes).toEqual([{ scope: "collections" }, { scope: "items", collectionId: book.id }, { scope: "views", collectionId: book.id }]);
    expect(await repo.listCollections()).toEqual([]);
    expect(await repo.listAllViews()).toEqual([]);
    expect(await repo.listBookmarks("default")).toEqual([]);
    expect(await repo.countItemsByCollection(null)).toEqual({});
    expect(await sql("SELECT count(*) AS n FROM items WHERE deleted_at IS NOT NULL")).toEqual([{ n: 1 }]);
    expect(await sql("SELECT count(*) AS n FROM fields WHERE deleted_at IS NOT NULL")).toEqual([{ n: 1 }]);
  });

  it("can go while it refers to itself, and lists every referrer when refused", async () => {
    const person = await collection("Person", [field("Name")]);
    const a = await collection("A", [field("T"), field("Who", "item", { targetCollectionId: person.id })]);
    await collection("B", [field("T"), field("Others", "item_list", { targetCollectionId: person.id })]);
    await expect(repo.deleteCollection(person.id)).rejects.toThrow(/Still referenced by .*“Who” of A.*“Others” of B|Still referenced by .*“Others” of B.*“Who” of A/);
    await repo.saveCollection({ ...collectionDraft(a), fields: [...a.fields, field("Self", "item", { targetCollectionId: a.id })] }, "default");
    await repo.deleteCollection(a.id);
    expect((await repo.listCollections()).map((c) => c.name)).toEqual(["B", "Person"]);
  });
});

describe("item values", () => {
  it("skip empty values and the computed and generated fields when created", async () => {
    const shared = component("Badge");
    await repo.saveComponent(shared);
    const note = await collection("Note", [field("Text"), field("Shown", "component", { componentId: shared.id }), field("Gen", "ai", { code: "Do {{ $item.Text }}", output: "string" }), field("N", "number")]);
    const [text, shown, gen, n] = note.fields;
    const id = await repo.createItem(note, { [text.id]: "hi", [shown.id]: "x", [gen.id]: "y", [n.id]: null }, "default");
    expect((await repo.getItem(note, id))?.values).toEqual({ [text.id]: "hi" });
    expect(await sql("SELECT count(*) AS n FROM field_values WHERE item_id = ?1", [id])).toEqual([{ n: 1 }]);
  });

  it("are changed per field: only changed fields are written, and an unchanged update writes nothing", async () => {
    const note = await collection("Note", [field("Text"), field("N", "number")]);
    const [text, n] = note.fields;
    const id = await repo.createItem(note, { [text.id]: "a", [n.id]: 1 }, "default");
    const before = await sql<{ field_id: string; updated_at: string }>("SELECT field_id, updated_at FROM field_values WHERE item_id = ?1", [id]);
    await new Promise((r) => setTimeout(r, 5));
    changes = [];
    await repo.updateItem(note, id, { [text.id]: "a", [n.id]: 1 });
    expect(changes).toEqual([]);
    await repo.updateItem(note, id, { [n.id]: 2 });
    expect(changes).toEqual([{ scope: "items", collectionId: note.id, itemId: id }]);
    const after = await sql<{ field_id: string; updated_at: string }>("SELECT field_id, updated_at FROM field_values WHERE item_id = ?1", [id]);
    const stamp = (rows: typeof before, fieldId: string) => rows.find((r) => r.field_id === fieldId)!.updated_at;
    expect(stamp(after, text.id)).toBe(stamp(before, text.id)); // untouched
    expect(stamp(after, n.id) > stamp(before, n.id)).toBe(true);
  });

  it("refuse an update of an item that is gone", async () => {
    const note = await collection("Note", [field("Text")]);
    const id = await repo.createItem(note, {}, "default");
    await repo.deleteItem(id);
    await expect(repo.updateItem(note, id, { [note.fields[0].id]: "x" })).rejects.toThrow("Item not found");
    await expect(repo.updateItem(note, "unknown", {})).rejects.toThrow("Item not found");
  });

  it("are listed a page at a time; a page past the end is empty", async () => {
    const note = await collection("Note", [field("Text")]);
    for (const t of ["a", "b", "c"]) await repo.createItem(note, { [note.fields[0].id]: t }, "default");
    expect(titles(await repo.listItems(note, "default", { limit: 2, offset: 0 }), note).sort()).toHaveLength(2);
    expect(await repo.listItems(note, "default", { limit: 2, offset: 2 })).toHaveLength(1);
    expect(await repo.listItems(note, "default", { limit: 2, offset: 5 })).toEqual([]);
    expect(await repo.getItems(note, [])).toEqual([]);
    expect(await repo.getItems(note, ["unknown"])).toEqual([]);
  });

  it("are not found through another collection", async () => {
    const note = await collection("Note", [field("Text")]);
    const other = await collection("Other", [field("Text")]);
    const id = await repo.createItem(note, {}, "default");
    expect(await repo.getItem(other, id)).toBeNull();
    expect(await repo.collectionsOfItems([id, "unknown"])).toEqual(new Map([[id, note.id]]));
  });

  it("report one change per collection when created together", async () => {
    const a = await collection("A", [field("T")]);
    const b = await collection("B", [field("T")]);
    changes = [];
    await repo.createItems([{ collection: a, values: {}, spaceId: "default" }, { collection: b, values: {}, spaceId: "default" }, { collection: a, values: {}, spaceId: "default" }]);
    expect(changes).toEqual([{ scope: "items", collectionId: a.id }, { scope: "items", collectionId: b.id }]);
  });
});

describe("AI fields", () => {
  let note: Collection;
  let gen: FieldDef;
  let id: string;
  beforeEach(async () => {
    note = await collection("Note", [field("Text"), field("Gen", "ai", { code: "Summarize {{ $item.Text }}", output: "string" }), field("Score", "ai", { code: "Rate {{ $item.Text }}", output: "number" })]);
    gen = note.fields[1];
    id = await repo.createItem(note, { [note.fields[0].id]: "long" }, "default");
  });

  it("store a generated value with the fingerprint of its prompt, leaving the item's own change time alone", async () => {
    const before = (await repo.getItem(note, id))!;
    await new Promise((r) => setTimeout(r, 5));
    await repo.setGenerated(note, id, gen, "short", "hash-1");
    await repo.setGenerated(note, id, note.fields[2], 7.5, "hash-2");
    const item = (await repo.getItem(note, id))!;
    expect(item.values).toMatchObject({ [gen.id]: "short", [note.fields[2].id]: 7.5 });
    expect(item.aiInputs).toEqual({ [gen.id]: "hash-1", [note.fields[2].id]: "hash-2" });
    expect(Object.keys(item.aiGeneratedAt ?? {}).sort()).toEqual([gen.id, note.fields[2].id].sort());
    expect(item.aiEdited).toBeUndefined();
    expect(item.updatedAt).toBe(before.updatedAt);
  });

  it("ignore a generated value for an item that was deleted meanwhile", async () => {
    await repo.deleteItem(id);
    await repo.setGenerated(note, id, gen, "late", "hash");
    expect(await sql("SELECT count(*) AS n FROM field_values WHERE field_id = ?1", [gen.id])).toEqual([{ n: 0 }]);
  });

  it("mark a value typed over a generated one as edited, until it is accepted for the prompt as it reads now", async () => {
    await repo.setGenerated(note, id, gen, "short", "hash-1");
    await repo.updateItem(note, id, { [gen.id]: "mine" });
    let item = (await repo.getItem(note, id))!;
    expect(item.values[gen.id]).toBe("mine");
    expect(item.aiEdited).toEqual({ [gen.id]: true });
    await repo.acceptEdit(note, id, gen, "hash-2");
    item = (await repo.getItem(note, id))!;
    expect(item.aiInputs?.[gen.id]).toBe("hash-2");
    expect(item.aiEdited).toEqual({ [gen.id]: true }); // still the user's own text
    expect(item.values[gen.id]).toBe("mine");
  });

  it("take a typed number over a generated number", async () => {
    const score = note.fields[2];
    await repo.setGenerated(note, id, score, 1, "h");
    await repo.updateItem(note, id, { [score.id]: 9 });
    const item = (await repo.getItem(note, id))!;
    expect(item.values[score.id]).toBe(9);
    expect(item.aiEdited).toEqual({ [score.id]: true });
  });

  it("are found by search", async () => {
    await repo.setGenerated(note, id, gen, "A sweeping summary", "h");
    expect((await repo.search("sweeping", await repo.listCollections(), "default")).map((i) => i.id)).toEqual([id]);
  });
});

describe("moving and pinning items", () => {
  it("leaves the item's bookmark behind in the old space, and moving to the same space changes nothing", async () => {
    const book = await collection("Book", [field("Title")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const id = await repo.createItem(book, {}, "default");
    await repo.addBookmark("item", book.id, id, "Book", "default");
    const before = (await repo.getItem(book, id))!;
    await new Promise((r) => setTimeout(r, 5));
    await repo.moveItem(id, "default");
    expect((await repo.getItem(book, id))!.updatedAt).toBe(before.updatedAt);
    expect(await repo.listBookmarks("default")).toHaveLength(1);
    changes = [];
    await repo.moveItem(id, "work");
    expect(changes).toEqual([{ scope: "items", collectionId: book.id, itemId: id }, { scope: "bookmarks" }]);
    expect(await repo.listBookmarks("default")).toEqual([]);
  });

  it("moves nothing for an unknown item, and tells nobody", async () => {
    changes = [];
    await repo.moveItem("unknown", "default");
    expect(changes).toEqual([]);
  });

  it("pins an item to an item view and back to the default", async () => {
    const book = await collection("Book", [field("Title")]);
    const id = await repo.createItem(book, {}, "default");
    changes = [];
    await repo.pinItemView(id, "compact");
    expect((await repo.getItem(book, id))?.itemViewId).toBe("compact");
    await repo.pinItemView(id, null);
    expect((await repo.getItem(book, id))?.itemViewId ?? null).toBeNull();
    expect(changes).toEqual(Array(2).fill({ scope: "items", collectionId: book.id, itemId: id }));
    changes = [];
    await repo.pinItemView("unknown", "x");
    expect(changes).toEqual([]);
  });
});

describe("item views", () => {
  const view = (id: string, name: string, isDefault = false): ItemView => ({
    id, name, isDefault, collapsed: { blocks: [], groups: {} }, layout: { fields: null, filters: [], hiddenLabels: [], blocks: [], editable: true, hideEmpty: false },
  });

  it("start with one Default view, and are replaced as a list", async () => {
    const book = await collection("Book", [field("Title")]);
    expect(book.itemViews.map((v) => [v.name, v.isDefault])).toEqual([["Default", true]]);
    changes = [];
    await repo.saveItemViews(book.id, [view("a", "Compact", true), view("b", "Wide")]);
    expect(changes).toEqual([{ scope: "collections" }]);
    const saved = (await repo.listCollections())[0];
    expect(saved.itemViews.map((v) => [v.id, v.name, v.isDefault])).toEqual([["a", "Compact", true], ["b", "Wide", false]]);
    await repo.saveItemViews(book.id, [view("b", "Wide", true)]);
    expect((await repo.listCollections())[0].itemViews.map((v) => v.id)).toEqual(["b"]);
  });

  it("fall back to the default view when the stored ones are unreadable", async () => {
    await collection("Book", [field("Title")]);
    await db().write([{ sql: "UPDATE collections SET item_views = 'not json'" }]);
    expect((await repo.listCollections())[0].itemViews.map((v) => v.name)).toEqual(["Default"]);
  });
});

describe("collection views", () => {
  it("update a saved view in place, and clear the default with null", async () => {
    const book = await collection("Book", [field("Title")]);
    const [all] = await repo.listViews(book.id, "default");
    await repo.saveView({ ...all, name: "Everything", position: 3 });
    expect((await repo.listViews(book.id, "default")).map((v) => [v.id, v.name, v.position])).toEqual([[all.id, "Everything", 3]]);
    await repo.setDefaultView(book.id, "default", all.id);
    await repo.setDefaultView(book.id, "default", null);
    expect((await repo.listViews(book.id, "default"))[0].isDefault).toBe(false);
  });

  it("star a default per space", async () => {
    const book = await collection("Book", [field("Title")]);
    const [all] = await repo.listViews(book.id, "default");
    const ts = new Date().toISOString();
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.saveView({ ...all, id: newId(), spaceId: "work", createdAt: ts, updatedAt: ts });
    await repo.setDefaultView(book.id, "default", all.id);
    expect((await repo.listViews(book.id, "work"))[0].isDefault).toBe(false);
    expect((await repo.listViews(book.id, "default"))[0].isDefault).toBe(true);
    expect(await repo.listAllViews()).toHaveLength(2);
  });

  it("delete an unknown view without telling anybody", async () => {
    changes = [];
    await repo.deleteView("unknown");
    expect(changes).toEqual([]);
  });
});

describe("bookmarks and what they lead to", () => {
  it("disappear from the list when their item or view is deleted", async () => {
    const book = await collection("Book", [field("Title")]);
    const id = await repo.createItem(book, {}, "default");
    const [all] = await repo.listViews(book.id, "default");
    await repo.addBookmark("item", book.id, id, "Item", "default");
    await repo.addBookmark("view", book.id, all.id, "View", "default");
    expect((await repo.listBookmarks("default")).map((b) => [b.kind, b.label, b.position])).toEqual([["item", "Item", 0], ["view", "View", 1]]);
    await repo.deleteItem(id);
    expect((await repo.listBookmarks("default")).map((b) => b.kind)).toEqual(["view"]);
    await repo.deleteView(all.id);
    expect(await repo.listBookmarks("default")).toEqual([]);
  });

  it("are numbered per space, and removing one leaves a gap that new ones go after", async () => {
    const book = await collection("Book", [field("Title")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const a = await repo.createItem(book, {}, "default");
    const b = await repo.createItem(book, {}, "default");
    await repo.addBookmark("item", book.id, a, "A", "default");
    await repo.addBookmark("item", book.id, b, "B", "default");
    await repo.addBookmark("item", book.id, a, "A in work", "work");
    await repo.removeBookmark(a, "default");
    await repo.addBookmark("item", book.id, a, "A again", "default");
    expect((await repo.listBookmarks("default")).map((x) => [x.label, x.position])).toEqual([["B", 1], ["A again", 2]]);
    expect((await repo.listBookmarks("work")).map((x) => [x.label, x.position])).toEqual([["A in work", 0]]);
  });

  it("report a relabel only when the label changes", async () => {
    const book = await collection("Book", [field("Title")]);
    const id = await repo.createItem(book, {}, "default");
    await repo.addBookmark("item", book.id, id, "Same", "default");
    changes = [];
    await repo.relabelBookmark(id, "Same");
    await repo.relabelBookmark("unknown", "x");
    expect(changes).toEqual([]);
    await repo.relabelBookmark(id, "New");
    expect(changes).toEqual([{ scope: "bookmarks" }]);
  });
});

describe("components in use", () => {
  it("can't go when it would leave a collection without fields", async () => {
    const shared = component("Badge");
    await repo.saveComponent(shared);
    await collection("Only", [field("Shown", "component", { componentId: shared.id })]);
    await expect(repo.deleteComponent(shared.id, { withFields: true })).rejects.toThrow(/Only would be left without fields/);
    expect((await repo.listComponents()).map((c) => c.name)).toEqual(["Badge"]);
  });

  it("is rewritten in place, listed by name, and reports its fields' collections when deleted with them", async () => {
    const shared = component("badge");
    await repo.saveComponent(shared);
    await repo.saveComponent(component("Alpha"));
    await repo.saveComponent({ ...shared, name: "Zed", code: "{{ 2 }}", ai: true, output: "string" });
    expect((await repo.listComponents()).map((c) => [c.name, c.code, c.ai, c.output])).toEqual([["Alpha", "{{ $item.Title }}", false, "markdown"], ["Zed", "{{ 2 }}", true, "string"]]);
    const plain = component("Plain");
    await repo.saveComponent(plain);
    await collection("Thing", [field("Title"), field("Shown", "component", { componentId: plain.id })]);
    changes = [];
    await repo.deleteComponent(plain.id, { withFields: true });
    expect(changes).toEqual([{ scope: "components" }, { scope: "collections" }]);
    changes = [];
    await repo.deleteComponent(shared.id);
    expect(changes).toEqual([{ scope: "components" }]);
  });

  it("reads an unknown stored output as markdown", async () => {
    await repo.saveComponent(component("Odd"));
    await db().write([{ sql: "UPDATE components SET output = 'hologram'" }]);
    expect((await repo.listComponents())[0].output).toBe("markdown");
  });
});

describe("files", () => {
  const photoCollection = () => collection("Photo", [field("Title"), field("Image", "image"), field("Notes", "markdown")]);
  const unusedSince = async (id: string) => (await sql<{ unused_since: string | null }>("SELECT unused_since FROM files WHERE id = ?1", [id]))[0]?.unused_since;
  /** A moment past the grace period: sweeping with it deletes whatever is marked unused. */
  const later = () => new Date(Date.now() + 1000).toISOString();

  it("are stored once per content, and the size and type are kept", async () => {
    const a = await repo.putFile(bytes("alpha"), "image/png");
    expect(await sql("SELECT mime, size FROM files WHERE id = ?1", [a])).toEqual([{ mime: "image/png", size: 5 }]);
    expect(await repo.putFile(bytes("alpha"), "image/png")).toBe(a);
    expect(await sql("SELECT count(*) AS n FROM files")).toEqual([{ n: 1 }]);
  });

  it("answer null for a file nobody has, offline", async () => {
    expect(await repo.getFile("f".repeat(64))).toBeNull();
    expect(await repo.getFile("f".repeat(64), { small: true })).toBeNull();
  });

  it("serve a thumbnail where one is asked for, else the original", async () => {
    const original = await repo.putFile(bytes("original"), "image/png");
    expect(await repo.getFile(original, { small: true })).toEqual({ data: bytes("original"), mime: "image/png" });
    await repo.putThumbnail(original, bytes("tiny"), "image/webp");
    await repo.putThumbnail(original, bytes("tiny"), "image/webp"); // again: ignored
    expect(await repo.getFile(original, { small: true })).toEqual({ data: bytes("tiny"), mime: "image/webp", small: true });
    expect(await repo.getFile(original)).toEqual({ data: bytes("original"), mime: "image/png" });
    expect(await sql("SELECT count(*) AS n FROM thumbnails")).toEqual([{ n: 1 }]);
  });

  it("are marked unused once no live item uses them, and kept while another still does", async () => {
    const photo = await photoCollection();
    const image = photo.fields[1];
    const shared = await repo.putFile(bytes("shared"), "image/png");
    const solo = await repo.putFile(bytes("solo"), "image/png");
    const one = await repo.createItem(photo, { [image.id]: shared }, "default");
    const two = await repo.createItem(photo, { [image.id]: shared }, "default");
    const three = await repo.createItem(photo, { [image.id]: solo }, "default");
    await repo.deleteItem(one);
    expect(await unusedSince(shared)).toBeNull();
    await repo.deleteItem(two);
    expect(await unusedSince(shared)).not.toBeNull();
    await repo.updateItem(photo, three, { [image.id]: null });
    expect(await unusedSince(solo)).not.toBeNull();
  });

  it("count a file used from Markdown text, and a thumbnail goes with its original", async () => {
    const photo = await photoCollection();
    const notes = photo.fields[2];
    const file = await repo.putFile(bytes("inline"), "image/png");
    await repo.putThumbnail(file, bytes("tiny"), "image/webp");
    const thumb = (await sql<{ thumb_id: string }>("SELECT thumb_id FROM thumbnails"))[0].thumb_id;
    const id = await repo.createItem(photo, { [notes.id]: `![](files/${file})` }, "default");
    await repo.releaseFiles([file, file]);
    expect(await unusedSince(file)).toBeNull(); // still used by the text
    await repo.updateItem(photo, id, { [notes.id]: "no picture" });
    expect(await unusedSince(file)).not.toBeNull();
    expect(await unusedSince(thumb)).not.toBeNull();
  });

  it("are deleted by a sweep once unused for the grace period, with their thumbnails, and not before", async () => {
    const photo = await photoCollection();
    const image = photo.fields[1];
    const file = await repo.putFile(bytes("gone soon"), "image/png");
    await repo.putThumbnail(file, bytes("tiny"), "image/webp");
    const id = await repo.createItem(photo, { [image.id]: file }, "default");
    await repo.deleteItem(id);
    await repo.sweepFiles();
    expect(await sql("SELECT count(*) AS n FROM files")).toEqual([{ n: 2 }]); // a week hasn't passed
    await repo.sweepFiles(later());
    expect(await sql("SELECT count(*) AS n FROM files")).toEqual([{ n: 0 }]);
    expect(await sql("SELECT count(*) AS n FROM thumbnails")).toEqual([{ n: 0 }]);
  });

  it("lose their mark when used again before the sweep", async () => {
    const photo = await photoCollection();
    const image = photo.fields[1];
    const file = await repo.putFile(bytes("back"), "image/png");
    const id = await repo.createItem(photo, { [image.id]: file }, "default");
    await repo.updateItem(photo, id, { [image.id]: null });
    expect(await unusedSince(file)).not.toBeNull();
    await repo.updateItem(photo, id, { [image.id]: file }); // an undo
    await repo.sweepFiles(later());
    expect(await unusedSince(file)).toBeNull();
    expect(await repo.getFile(file)).not.toBeNull();
  });

  it("are reported unused only when no live item uses them", async () => {
    const photo = await photoCollection();
    const image = photo.fields[1];
    const used = await repo.putFile(bytes("used"), "image/png");
    const loose = await repo.putFile(bytes("loose"), "image/png");
    await repo.createItem(photo, { [image.id]: used }, "default");
    expect(await repo.unusedFiles([])).toEqual([]);
    expect(await repo.unusedFiles([used, loose, loose])).toEqual([loose]);
  });

  it("are marked unused when their collection is deleted", async () => {
    const photo = await photoCollection();
    const file = await repo.putFile(bytes("p"), "image/png");
    await repo.createItem(photo, { [photo.fields[1].id]: file }, "default");
    await repo.deleteCollection(photo.id);
    expect(await unusedSince(file)).not.toBeNull();
  });
});

describe("search", () => {
  it("looks in lists, checklists and HTML, and respects the limit and the space", async () => {
    const note = await collection("Note", [field("Title"), field("Tags", "string_list"), field("Todo", "checklist"), field("Body", "html")]);
    const [title, tags, todo, body] = note.fields;
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const a = await repo.createItem(note, { [title.id]: "A", [tags.id]: ["alpha", "beta"] }, "default");
    const b = await repo.createItem(note, { [title.id]: "B", [todo.id]: ["[ ] Buy MILK"] }, "default");
    const c = await repo.createItem(note, { [title.id]: "C", [body.id]: "<p>milk</p>" }, "default");
    await repo.createItem(note, { [title.id]: "D milk" }, "work");
    const all = await repo.listCollections();
    expect((await repo.search("beta", all, "default")).map((i) => i.id)).toEqual([a]);
    expect((await repo.search("milk", all, "default")).map((i) => i.id).sort()).toEqual([b, c].sort());
    expect(await repo.search("milk", all, "default", 1)).toHaveLength(1);
    expect((await repo.search("milk", all, "work")).map((i) => i.values[title.id])).toEqual(["D milk"]);
    expect(await repo.search("milk", [], "default")).toEqual([]);
    expect(await repo.search("nothing like it", all, "default")).toEqual([]);
  });

  it("finds items through the labels of a list of references", async () => {
    const person = await collection("Person", [field("Name")]);
    const team = await collection("Team", [field("Title"), field("Members", "item_list", { targetCollectionId: person.id })]);
    const ann = await repo.createItem(person, { [person.fields[0].id]: "Ann Lee" }, "default");
    const t = await repo.createItem(team, { [team.fields[0].id]: "Core", [team.fields[1].id]: [ann] }, "default");
    expect((await repo.search("lee", await repo.listCollections(), "default")).map((i) => i.id).sort()).toEqual([ann, t].sort());
  });

  it("does not return deleted items", async () => {
    const note = await collection("Note", [field("Title")]);
    const id = await repo.createItem(note, { [note.fields[0].id]: "findable" }, "default");
    await repo.deleteItem(id);
    expect(await repo.search("findable", await repo.listCollections(), "default")).toEqual([]);
  });
});

describe("remote collections", () => {
  const source = {
    name: "CRM",
    target: { table: { schema: "public", name: "people" } },
    key: "id",
    columns: [{ name: "id", type: "integer", kind: "number" as const }, { name: "name", type: "text", kind: "string" as const }],
  };
  const remote = async () => {
    const id = newId();
    await repo.saveCollection(
      { id, name: "Person", pluralName: "People", icon: null, description: "", spaceIds: null, source, fields: [field("Id", "number", { column: "id" }), field("Name", "string", { column: "name" })] },
      "default",
    );
    return (await repo.listCollections()).find((c) => c.id === id)!;
  };

  it("keep a bookmark of a row (its id is a key: no stored item), until the collection goes", async () => {
    const people = await remote();
    const row = rowItemId("42");
    await repo.addBookmark("item", people.id, row, "Ada", "default");
    expect((await repo.listBookmarks("default")).map((b) => [b.targetId, b.label])).toEqual([[row, "Ada"]]);
    await repo.removeBookmark(row, "default");
    expect(await repo.listBookmarks("default")).toEqual([]);
    await repo.addBookmark("item", people.id, row, "Ada", "default");
    await repo.deleteCollection(people.id);
    expect(await repo.listBookmarks("default")).toEqual([]);
  });

  it("store their source and the column each field shows", async () => {
    const people = await remote();
    expect(people.source).toMatchObject({ name: "CRM", key: "id" });
    expect(people.fields.map((f) => f.column)).toEqual(["id", "name"]);
  });

  it("are read-only: creating, updating or generating values is refused", async () => {
    const people = await remote();
    const message = /People are read from CRM: they can't be changed here/;
    await expect(repo.createItem(people, {}, "default")).rejects.toThrow(message);
    await expect(repo.createItems([{ collection: people, values: {}, spaceId: "default" }])).rejects.toThrow(message);
    await expect(repo.updateItem(people, "x", {})).rejects.toThrow(message);
    await expect(repo.setGenerated(people, "x", people.fields[1], "v", "h")).rejects.toThrow(message);
    expect(await sql("SELECT count(*) AS n FROM items")).toEqual([{ n: 0 }]);
  });

  it("must name a key column, and may have only component fields of their own", async () => {
    const draft = { id: newId(), name: "Person", pluralName: "People", icon: null, description: "", spaceIds: null, source: { ...source, key: "missing" }, fields: [field("Id", "number", { column: "id" })] };
    await expect(repo.saveCollection(draft, "default")).rejects.toThrow("Choose the column that tells rows apart");
    await expect(repo.saveCollection({ ...draft, source, fields: [field("Own", "string")] }, "default")).rejects.toThrow(/own fields are component fields/);
  });

  it("follow a column whose type changed", async () => {
    const people = await remote();
    const next = { ...source, columns: [{ name: "id", type: "text", kind: "string" as const }, source.columns[1]] };
    await repo.saveCollection({ ...collectionDraft(people), source: next, fields: [{ ...people.fields[0], kind: "string" }, people.fields[1]] }, "default");
    expect((await repo.listCollections()).find((c) => c.id === people.id)!.fields[0].kind).toBe("string");
  });
});

describe("the device", () => {
  it("reports whether its storage is persistent", () => {
    expect(repo.storage).toEqual({ persistent: nodeEngine }); // a file under node:sqlite, memory under sqlite-wasm
  });

  it("wipes everything locally, pausing sync, and starts over with the default space", async () => {
    const book = await collection("Book", [field("Title")]);
    await repo.createItem(book, {}, "default");
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.wipeLocal();
    expect(await repo.listCollections()).toEqual([]);
    expect((await repo.listSpaces()).map((s) => s.id)).toEqual(["default"]);
    expect(await sql("SELECT count(*) AS n FROM items")).toEqual([{ n: 0 }]);
    expect(repo.sync.status.state).toBe("off");
  });
});
