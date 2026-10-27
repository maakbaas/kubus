import { expect, it } from "vitest";
import { aiRequest } from "./ai";
import type { Collection, FieldDef, Item } from "./model";

const f = (id: string, kind: FieldDef["kind"], ai?: Partial<FieldDef>): FieldDef => ({
  id, collectionId: "t", name: id, kind, targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false, aiPrompt: null, aiOutput: null, position: 0, ...ai,
});
const item: Item = { id: "i", collectionId: "t", spaceId: "default", values: {}, createdAt: "", updatedAt: "" };

it("tells the model what to answer when it can't tell", () => {
  const text = f("a", "ai", { aiPrompt: "Say", aiOutput: "markdown" });
  const num = f("b", "ai", { aiPrompt: "Say", aiOutput: "number" });
  const c: Collection = { id: "t", name: "T", pluralName: "Ts", icon: null, description: "", itemViews: [], spaceIds: null, fields: [text, num], createdAt: "", updatedAt: "" };
  expect(aiRequest(c, text, item, () => "")).toMatchObject({ system: expect.stringContaining("exactly: Unknown") });
  expect(aiRequest(c, num, item, () => "")).toMatchObject({ system: expect.stringContaining("an empty reply") });
});
