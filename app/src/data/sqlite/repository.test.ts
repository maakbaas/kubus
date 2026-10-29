// @vitest-environment node
// The Repository contract (data/repository.ts) on SQLite, method by method: what the UI and the
// API rely on, without sync (data/sync/*.test.ts) or the HTTP API (headless/api.test.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { device } from "../../test/fakeServer";
import { collectionDraft, itemLabel, newId, NO_TITLE, type Collection, type FieldDef, type FieldKind } from "../../domain/model";
import type { CollectionView } from "../../domain/views";
import type { DataChange } from "../repository";

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

describe("the change feed", () => {
  it("reports each committed write with its scope", async () => {
    const book = await collection("Book", [field("Title")]);
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    expect(changes).toEqual([{ scope: "collections" }, { scope: "items", collectionId: book.id, itemId: id }, { scope: "spaces" }]);
  });

  it("reports nothing for a write that is refused", async () => {
    await expect(repo.deleteSpace("default")).rejects.toThrow(/only space/);
    expect(changes).toEqual([]);
  });
});

describe("spaces", () => {
  it("start with the default one; new ones go last, renamed in place", async () => {
    expect((await repo.listSpaces()).map((s) => s.id)).toEqual(["default"]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.saveSpace({ id: "home", name: "Home", icon: "Home" });
    await repo.saveSpace({ id: "work", name: "Office", icon: null });
    expect((await repo.listSpaces()).map((s) => [s.id, s.name])).toEqual([["default", "Space"], ["work", "Office"], ["home", "Home"]]);
  });

  it("are deleted with their items, views and bookmarks; the last one stays", async () => {
    const book = await collection("Book", [field("Title")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const there = await repo.createItem(book, { [book.fields[0].id]: "Report" }, "work");
    await repo.createItem(book, { [book.fields[0].id]: "Novel" }, "default");
    await repo.addBookmark("item", book.id, there, "Report", "work");
    await repo.deleteSpace("work");
    expect((await repo.listSpaces()).map((s) => s.id)).toEqual(["default"]);
    expect(await repo.getItem(book, there)).toBeNull();
    expect(await repo.listBookmarks("work")).toEqual([]);
    expect(titles(await repo.listItems(book, "default"), book)).toEqual(["Novel"]);
    await expect(repo.deleteSpace("default")).rejects.toThrow(/only space/);
  });
});

describe("collections", () => {
  it("get an All view in the space they are made in", async () => {
    const book = await collection("Book", [field("Title")]);
    expect((await repo.listViews(book.id, "default")).map((v) => v.name)).toEqual(["All"]);
  });

  it("keep their items' values when fields are renamed, reordered or added; lose a removed field's", async () => {
    const book = await collection("Book", [field("Title"), field("Pages", "number")]);
    const [title, pages] = book.fields;
    const id = await repo.createItem(book, { [title.id]: "Dune", [pages.id]: 412 }, "default");
    const year = field("Year", "number");
    await repo.saveCollection({ ...book, spaceIds: null, fields: [pages, { ...title, name: "Name" }, year] }, "default");
    let saved = (await repo.listCollections()).find((c) => c.id === book.id)!;
    expect(saved.fields.map((f) => f.name)).toEqual(["Pages", "Name", "Year"]);
    expect((await repo.getItem(saved, id))?.values).toEqual({ [pages.id]: 412, [title.id]: "Dune" });
    await repo.saveCollection({ ...saved, spaceIds: null, fields: saved.fields.filter((f) => f.id !== pages.id) }, "default");
    saved = (await repo.listCollections()).find((c) => c.id === book.id)!;
    expect((await repo.getItem(saved, id))?.values).toEqual({ [title.id]: "Dune" });
  });

  it("can't be deleted while another collection refers to them", async () => {
    const person = await collection("Person", [field("Name")]);
    const book = await collection("Book", [field("Title"), field("Author", "item", { targetCollectionId: person.id })]);
    await expect(repo.deleteCollection(person.id)).rejects.toThrow(/Still referenced by “Author” of Book/);
    await repo.deleteCollection(book.id);
    await repo.deleteCollection(person.id);
    expect(await repo.listCollections()).toEqual([]);
  });
});

describe("items", () => {
  let book: Collection;
  beforeEach(async () => {
    book = await collection("Book", [field("Title"), field("Tags", "string_list"), field("Read", "checkbox"), field("Pages", "number")]);
  });

  it("keep every kind of value as given", async () => {
    const [title, tags, read, pages] = book.fields;
    const id = await repo.createItem(book, { [title.id]: "Dune", [tags.id]: ["sf", "classic"], [read.id]: true, [pages.id]: 412.5 }, "default");
    expect((await repo.getItem(book, id))?.values).toEqual({ [title.id]: "Dune", [tags.id]: ["sf", "classic"], [read.id]: true, [pages.id]: 412.5 });
    await repo.updateItem(book, id, { [pages.id]: null, [read.id]: false });
    const values = (await repo.getItem(book, id))!.values;
    expect(values).toMatchObject({ [title.id]: "Dune", [tags.id]: ["sf", "classic"], [read.id]: false });
    expect(values[pages.id] ?? null).toBeNull(); // cleared: null or left out, both mean no value
  });

  it("are listed per space, most recently changed first, a page at a time", async () => {
    const title = book.fields[0].id;
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const a = await repo.createItem(book, { [title]: "A" }, "default");
    await repo.createItem(book, { [title]: "B" }, "default");
    await repo.createItem(book, { [title]: "Elsewhere" }, "work");
    await new Promise((r) => setTimeout(r, 5));
    await repo.updateItem(book, a, { [title]: "A2" });
    expect(titles(await repo.listItems(book, "default"), book)).toEqual(["A2", "B"]);
    expect(titles(await repo.listItems(book, "default", { limit: 1, offset: 1 }), book)).toEqual(["B"]);
    expect(await repo.countItemsByCollection("default")).toEqual({ [book.id]: 2 });
    expect(await repo.countItemsByCollection(null)).toEqual({ [book.id]: 3 });
  });

  it("move between spaces, and are found whichever space they are in", async () => {
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    await repo.moveItem(id, "work");
    expect(await repo.listItems(book, "default")).toEqual([]);
    expect((await repo.getItem(book, id))?.spaceId).toBe("work");
    expect((await repo.getItems(book, [id])).map((i) => i.id)).toEqual([id]);
  });

  it("are gone once deleted, but their collection is still known", async () => {
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    await repo.deleteItem(id);
    expect(await repo.getItem(book, id)).toBeNull();
    expect(await repo.getItems(book, [id])).toEqual([]);
    expect(await repo.collectionsOfItems([id])).toEqual(new Map([[id, book.id]]));
  });

  it("are made together, referring to each other, in one change set", async () => {
    const person = await collection("Person", [field("Name"), field("Favourite", "item", { targetCollectionId: book.id })]);
    const bookId = newId();
    changes = [];
    const [, personId] = await repo.createItems([
      { collection: book, values: { [book.fields[0].id]: "Dune" }, spaceId: "default", id: bookId },
      { collection: person, values: { [person.fields[0].id]: "Ann", [person.fields[1].id]: bookId }, spaceId: "default" },
    ]);
    expect((await repo.getItem(person, personId))?.values[person.fields[1].id]).toBe(bookId);
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe("labels and search", () => {
  it("label an item by its first string field with a value, across spaces", async () => {
    const person = await collection("Person", [field("Nick"), field("Name")]);
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const a = await repo.createItem(person, { [person.fields[0].id]: "  ", [person.fields[1].id]: "Ann" }, "default");
    const b = await repo.createItem(person, { [person.fields[0].id]: "Bobby", [person.fields[1].id]: "Bob" }, "work");
    const c = await repo.createItem(person, {}, "default");
    const labels = await repo.listLabels(person);
    expect(labels.sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [{ id: a, label: "Ann", spaceId: "default" }, { id: b, label: "Bobby", spaceId: "work" }, { id: c, label: null, spaceId: "default" }].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(await repo.listLabels(person, [b])).toEqual([{ id: b, label: "Bobby", spaceId: "work" }]);
  });

  it("label an item by its collection's title field, or not at all without one", async () => {
    const person = await collection("Person", [field("Nick"), field("Name")]);
    const a = await repo.createItem(person, { [person.fields[0].id]: "Bobby", [person.fields[1].id]: "Bob" }, "default");
    const titled = async (titleField: string) => {
      await repo.saveCollection({ ...collectionDraft(person), titleField }, "default");
      const saved = (await repo.listCollections()).find((c) => c.id === person.id)!;
      return { saved, label: (await repo.listLabels(saved))[0].label };
    };
    const byName = await titled(person.fields[1].id);
    expect(byName).toMatchObject({ saved: { titleField: person.fields[1].id }, label: "Bob" });
    expect(itemLabel(byName.saved, (await repo.getItem(byName.saved, a))!)).toBe("Bob");
    const none = await titled(NO_TITLE);
    expect(none.label).toBeNull();
    expect(itemLabel(none.saved, (await repo.getItem(none.saved, a))!)).toBe("Person");
  });

  it("label an item by a number or date title field, as it is shown", async () => {
    const weigh = await collection("Weighing", [field("Note"), field("Weight", "number"), field("Day", "date")]);
    const a = await repo.createItem(weigh, { [weigh.fields[0].id]: "Morning", [weigh.fields[1].id]: 78.5, [weigh.fields[2].id]: "2026-10-28" }, "default");
    const b = await repo.createItem(weigh, { [weigh.fields[0].id]: "Evening" }, "default");
    for (const [f, label] of [[weigh.fields[1], "78.5"], [weigh.fields[2], "2026-10-28"]] as const) {
      await repo.saveCollection({ ...collectionDraft(weigh), titleField: f.id }, "default");
      const saved = (await repo.listCollections()).find((c) => c.id === weigh.id)!;
      expect(saved.titleField).toBe(f.id);
      const labels = new Map((await repo.listLabels(saved)).map((l) => [l.id, l.label]));
      expect([labels.get(a), labels.get(b)]).toEqual([label, null]);
      expect(itemLabel(saved, (await repo.getItem(saved, a))!)).toBe(label);
      expect(itemLabel(saved, (await repo.getItem(saved, b))!)).toBe("Weighing");
    }
  });

  it("finds text in a space, also through the labels of referenced items", async () => {
    const person = await collection("Person", [field("Name")]);
    const book = await collection("Book", [field("Title"), field("Notes", "markdown"), field("Author", "item", { targetCollectionId: person.id })]);
    const herbert = await repo.createItem(person, { [person.fields[0].id]: "Frank Herbert" }, "default");
    const dune = await repo.createItem(book, { [book.fields[0].id]: "Dune", [book.fields[1].id]: "A \\[\\[desert\\]\\] planet", [book.fields[2].id]: herbert }, "default");
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.createItem(book, { [book.fields[0].id]: "Dune notes" }, "work");
    const all = await repo.listCollections();
    expect((await repo.search("dune", all, "default")).map((i) => i.id)).toEqual([dune]);
    expect((await repo.search("[[desert]]", all, "default")).map((i) => i.id)).toEqual([dune]);
    expect((await repo.search("herbert", all, "default")).map((i) => i.id).sort()).toEqual([herbert, dune].sort());
    expect(await repo.search("  ", all, "default")).toEqual([]);
  });
});

describe("views", () => {
  it("star one default per collection and space, and are deleted", async () => {
    const book = await collection("Book", [field("Title")]);
    const [all] = await repo.listViews(book.id, "default");
    const ts = new Date().toISOString();
    const reading: CollectionView = { ...all, id: newId(), name: "Reading", position: 1, isDefault: false, createdAt: ts, updatedAt: ts };
    await repo.saveView(reading);
    await repo.setDefaultView(book.id, "default", reading.id);
    expect((await repo.listViews(book.id, "default")).map((v) => [v.name, v.isDefault])).toEqual([["All", false], ["Reading", true]]);
    await repo.setDefaultView(book.id, "default", all.id);
    expect((await repo.listViews(book.id, "default")).map((v) => [v.name, v.isDefault])).toEqual([["All", true], ["Reading", false]]);
    await repo.deleteView(reading.id);
    expect((await repo.listViews(book.id, "default")).map((v) => v.name)).toEqual(["All"]);
    expect((await repo.listAllViews()).map((v) => v.name)).toEqual(["All"]);
  });

  it("keep \"Show filter bar\" in their config, and drop it when it is taken off", async () => {
    const book = await collection("Book", [field("Title")]);
    const [all] = await repo.listViews(book.id, "default");
    expect(all.filterBar).toBeUndefined();
    await repo.saveView({ ...all, filterBar: true });
    expect((await repo.listViews(book.id, "default"))[0].filterBar).toBe(true);
    const { filterBar: _on, ...off } = (await repo.listViews(book.id, "default"))[0];
    await repo.saveView(off);
    expect("filterBar" in (await repo.listViews(book.id, "default"))[0]).toBe(false);
  });
});

describe("bookmarks", () => {
  it("are kept per space in the order added, relabelled and removed", async () => {
    const book = await collection("Book", [field("Title")]);
    const a = await repo.createItem(book, {}, "default");
    const b = await repo.createItem(book, {}, "default");
    await repo.addBookmark("item", book.id, a, "A", "default");
    await repo.addBookmark("item", book.id, b, "B", "default");
    await repo.relabelBookmark(a, "A2");
    expect((await repo.listBookmarks("default")).map((x) => [x.targetId, x.label])).toEqual([[a, "A2"], [b, "B"]]);
    await repo.removeBookmark(a, "default");
    expect((await repo.listBookmarks("default")).map((x) => x.targetId)).toEqual([b]);
  });
});

describe("components", () => {
  it("can't be deleted while a field uses them, unless with those fields", async () => {
    const ts = new Date().toISOString();
    const component = { id: newId(), name: "Badge", description: "", code: "{{ $item.Title }}", output: "markdown" as const, frameRatio: null, ai: false, createdAt: ts, updatedAt: ts };
    await repo.saveComponent(component);
    const book = await collection("Book", [field("Title"), field("Badge", "component", { componentId: component.id })]);
    await expect(repo.deleteComponent(component.id)).rejects.toThrow(/Still used by “Badge” of Book/);
    await repo.deleteComponent(component.id, { withFields: true });
    expect(await repo.listComponents()).toEqual([]);
    expect((await repo.listCollections()).find((c) => c.id === book.id)?.fields.map((f) => f.name)).toEqual(["Title"]);
  });
});

describe("files", () => {
  it("are stored once per content", async () => {
    const data = new TextEncoder().encode("bytes");
    const id = await repo.putFile(data, "image/png");
    expect(await repo.putFile(data, "image/png")).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await repo.getFile(id)).toEqual({ data, mime: "image/png" });
  });
});
