// @vitest-environment node
// Promoting a local component to a shared one, against the real repository.
import { describe, expect, it } from "vitest";
import type { Component } from "../domain/components";
import { blankField, newId } from "../domain/model";
import { newBlock, type CollectionView } from "../domain/views";
import { device } from "../test/fakeServer";
import { pickShared } from "./promoteLocal";

const shared = (id = newId()): Component => ({ id, name: "Shared", description: "", code: "{{ $item.Name }}", output: "markdown", frameRatio: null, ai: false, createdAt: "", updatedAt: "" });

async function setup(opts: { fieldKind?: "component" | "ai" } = {}) {
  const repo = await device({ connect: false });
  const id = newId();
  const nameId = newId();
  const calcId = newId();
  const blockOptions = { componentId: null, local: { code: "local {{ $items.length }}", output: "markdown" }, height: 12345 };
  await repo.saveCollection(
    {
      id, name: "Book", pluralName: "Books", icon: null, description: "", spaceIds: null,
      fields: [
        blankField(nameId, "Name", "string"),
        blankField(calcId, "Calc", opts.fieldKind ?? "component", { position: 1, code: "{{ $item.Name }}", output: opts.fieldKind === "ai" ? "number" : "markdown", frameRatio: "16:9" }),
      ],
    },
    "default",
  );
  const collection = (await repo.listCollections()).find((c) => c.id === id)!;
  return { repo, collection, calc: collection.fields[1], block: { ...newBlock("markdown", { text: "hello" }, "blk"), options: blockOptions } };
}

describe("pickShared", () => {
  it("a component field takes the shared component and drops its own code", async () => {
    const t = await setup();
    const component = shared();
    await t.repo.saveComponent(component);
    await pickShared(t.repo, { type: "field", collectionId: t.collection.id, fieldId: t.calc.id }, component, [t.collection], "default");
    const field = (await t.repo.listCollections()).find((c) => c.id === t.collection.id)!.fields.find((f) => f.id === t.calc.id)!;
    expect(field).toMatchObject({ componentId: component.id, code: null, output: null, frameRatio: null });
    expect((await t.repo.listCollections())[0].fields).toHaveLength(2); // the others are as they were
  });

  it("an AI field keeps its output: the values it already holds have that form", async () => {
    const t = await setup({ fieldKind: "ai" });
    const component = shared();
    await t.repo.saveComponent(component);
    await pickShared(t.repo, { type: "field", collectionId: t.collection.id, fieldId: t.calc.id }, component, [t.collection], "default");
    const field = (await t.repo.listCollections()).find((c) => c.id === t.collection.id)!.fields.find((f) => f.id === t.calc.id)!;
    expect(field).toMatchObject({ componentId: component.id, code: null, output: "number" });
  });

  it("a block of an item view becomes a component block showing the shared component, keeping its height", async () => {
    const t = await setup();
    const component = shared();
    const other = { ...newBlock("table", null, "other") };
    await t.repo.saveItemViews(t.collection.id, [
      { id: "iv1", name: "Default", isDefault: true, collapsed: {} as never, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false, filters: [], blocks: [t.block, other] } },
      { id: "iv2", name: "Other view", isDefault: false, collapsed: {} as never, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false, filters: [], blocks: [{ ...t.block }] } },
    ]);
    const collection = (await t.repo.listCollections()).find((c) => c.id === t.collection.id)!;
    await pickShared(t.repo, { type: "itemView", collectionId: collection.id, itemViewId: "iv1", blockId: "blk", markdown: true }, component, [collection], "default");
    const views = (await t.repo.listCollections()).find((c) => c.id === t.collection.id)!.itemViews;
    const [first, second] = views;
    expect(first.layout.blocks[0]).toMatchObject({ id: "blk", kind: "component" });
    expect(first.layout.blocks[0].options).toMatchObject({ componentId: component.id, local: null });
    expect((first.layout.blocks[0].options as { height: number }).height).toBeGreaterThan(0);
    expect(first.layout.blocks[1]).toMatchObject({ id: "other", kind: "table" }); // untouched
    expect(second.layout.blocks[0].kind).toBe("markdown"); // the same block id in another item view is another block
  });

  it("a block of a collection view too", async () => {
    const t = await setup();
    const component = shared();
    const view: CollectionView = {
      id: "v1", collectionId: t.collection.id, spaceId: "default", name: "All", position: 0, isDefault: false, collapsed: {} as never,
      filters: [], editable: true, blocks: [t.block, newBlock("table", null, "b2")], createdAt: "", updatedAt: "",
    };
    await t.repo.saveView(view);
    await pickShared(t.repo, { type: "view", collectionId: t.collection.id, viewId: "v1", blockId: "blk", markdown: true }, component, [t.collection], "default");
    const saved = (await t.repo.listAllViews()).find((v) => v.id === "v1")!;
    expect(saved.blocks.map((b) => b.kind)).toEqual(["component", "table"]);
    expect(saved.blocks[0].options).toMatchObject({ componentId: component.id, local: null });
    expect(saved.name).toBe("All");
  });

  it("says when the collection or the view is gone", async () => {
    const t = await setup();
    const component = shared();
    const gone = { type: "field", collectionId: "nope", fieldId: "x" } as const;
    await expect(pickShared(t.repo, gone, component, [t.collection], "default")).rejects.toThrow("Its collection is gone");
    await expect(pickShared(t.repo, { type: "view", collectionId: t.collection.id, viewId: "nope", blockId: "b", markdown: false }, component, [t.collection], "default")).rejects.toThrow("Its view is gone");
  });
});

