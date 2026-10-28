// @vitest-environment node
import { describe, expect, it } from "vitest";
import { device } from "../test/fakeServer";
import { newId, type FieldDef } from "../domain/model";
import { ItemCache } from "./itemCache";

const field = (name: string): FieldDef => ({
  id: newId(), collectionId: "", name, kind: "string", targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0,
});

/** Waits until `check` holds (the cache reloads after the repository's change events). */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("the labels cache", () => {
  it("keeps its list through an edit that leaves the label as it was, and changes with the label", async () => {
    const repo = await device({ connect: false });
    const id = newId();
    await repo.saveCollection({ id, name: "Project", pluralName: "Projects", icon: null, description: "", spaceIds: null, fields: [field("Name"), { ...field("Notes"), position: 1 }] }, "default");
    const collection = (await repo.listCollections()).find((c) => c.id === id)!;
    const [name, notes] = collection.fields;
    const itemId = await repo.createItem(collection, { [name.id]: "Apollo" }, "default");
    const cache = new ItemCache(repo, (cid) => (cid === id ? collection : undefined), () => "default");
    let heard = 0;
    cache.labels.subscribe(id, () => heard++);
    await until(() => cache.labels.snapshot(id).items !== null);
    const loaded = cache.labels.snapshot(id).items;
    heard = 0;

    await repo.updateItem(collection, itemId, { [notes.id]: "a note" });
    await cache.labels.settled(id, itemId);
    expect(cache.labels.snapshot(id).items).toBe(loaded);
    expect(heard).toBe(0);

    await repo.updateItem(collection, itemId, { [name.id]: "Artemis" });
    await cache.labels.settled(id, itemId);
    await until(() => cache.labels.snapshot(id).items?.[0]?.label === "Artemis");
    expect(cache.labels.snapshot(id).items).not.toBe(loaded);
    cache.dispose();
  });
});
