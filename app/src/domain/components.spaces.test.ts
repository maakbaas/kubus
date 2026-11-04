import { describe, expect, it } from "vitest";
import { componentsUsedIn, localUsedIn, type LocalComponent } from "./components";

const block = (componentId: string) => ({ id: `b-${componentId}`, title: "", kind: "component", options: { componentId } });

describe("components used in a space", () => {
  const collections = [
    { id: "books", spaceIds: null, itemViews: [{ layout: { blocks: [block("onPage")] } }], fields: [{ componentId: "onField", code: null }] },
    { id: "work", spaceIds: ["work"], itemViews: [], fields: [{ componentId: "workOnly", code: null }] },
  ] as never;
  const views = [
    { id: "v1", collectionId: "books", name: "All", spaceId: "home", blocks: [block("inHomeView")] },
    { id: "v2", collectionId: "books", name: "All", spaceId: "work", blocks: [block("inWorkView")] },
  ];
  const dashboards = [{ id: "d", spaceIds: null }];
  // The dashboard has tabs only in "work": "home" shows copies of them.
  const dashboardViews = [{ dashboardId: "d", spaceId: "work", blocks: [block("onDashboard")] }];

  it("counts fields, item views and views of the space, and the dashboards it shows", () => {
    const home = componentsUsedIn("home", { collections, views, dashboards, dashboardViews });
    expect([...home].sort()).toEqual(["inHomeView", "onDashboard", "onField", "onPage"]);
    const work = componentsUsedIn("work", { collections, views, dashboards, dashboardViews });
    expect(work.has("workOnly") && work.has("inWorkView") && !work.has("inHomeView")).toBe(true);
  });

  it("places a local component where it is written", () => {
    const inView = { owner: { type: "view", collectionId: "books", viewId: "v2", blockId: "b", markdown: false } } as LocalComponent;
    expect(localUsedIn(inView, "work", collections, views)).toBe(true);
    expect(localUsedIn(inView, "home", collections, views)).toBe(false);
  });
});
