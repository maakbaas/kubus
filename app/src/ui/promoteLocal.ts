// Promoting a local component (written in place) to a shared one, from wherever it is listed: the
// shared component is saved first (PromoteComponentModal), then its owner picks it instead of
// its own code. The owner is found again as stored now, so nothing else about it changes.

import type { Repository } from "../data";
import { type Component, type LocalOwner } from "../domain/components";
import { collectionDraft, type Collection } from "../domain/model";
import type { CollectionView, ViewBlock } from "../domain/views";
import type { ComponentBlockOptions } from "../views/ComponentBlock";
import { normalizeAspect, normalizeBlockHeight } from "../domain/views";

/** The block, now showing the shared component (a Markdown block becomes a component block). */
const promotedBlock = (block: ViewBlock, componentId: string): ViewBlock => ({
  ...block,
  kind: "component",
  // A component block keeps its height.
  options: {
    componentId,
    height: normalizeBlockHeight((block.options as { height?: unknown } | null)?.height),
    aspect: normalizeAspect((block.options as { aspect?: unknown } | null)?.aspect),
    local: null,
  } satisfies ComponentBlockOptions,
});

export async function pickShared(repo: Repository, owner: LocalOwner, component: Component, collections: Collection[], spaceId: string): Promise<void> {
  const collection = collections.find((c) => c.id === owner.collectionId);
  if (!collection) throw new Error("Its collection is gone");
  if (owner.type === "field") {
    const draft = collectionDraft(collection);
    // An AI field keeps its output (its values' form); a component field takes the shared one's.
    draft.fields = draft.fields.map((f) =>
      f.id === owner.fieldId ? { ...f, componentId: component.id, code: null, output: f.kind === "ai" ? f.output : null, frameRatio: null } : f,
    );
    await repo.saveCollection(draft, spaceId);
  } else if (owner.type === "itemView") {
    const views = collection.itemViews.map((v) =>
      v.id === owner.itemViewId
        ? { ...v, layout: { ...v.layout, blocks: v.layout.blocks.map((b) => (b.id === owner.blockId ? promotedBlock(b, component.id) : b)) } }
        : v,
    );
    await repo.saveItemViews(collection.id, views);
  } else {
    const view = (await repo.listAllViews()).find((v: CollectionView) => v.id === owner.viewId);
    if (!view) throw new Error("Its view is gone");
    await repo.saveView({ ...view, blocks: view.blocks.map((b) => (b.id === owner.blockId ? promotedBlock(b, component.id) : b)) });
  }
}
