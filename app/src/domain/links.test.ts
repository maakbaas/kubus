import { describe, expect, it } from "vitest";
import { describeLink, parseNameLink, resolveNameLink, slug, slugs, type LinkData } from "./links";
import type { Collection, ItemLabel } from "./model";
import type { CollectionView, ViewBlock } from "./views";
import type { Dashboard, DashboardView } from "./dashboards";

const block = (id: string, title: string, kind = "table") => ({ id, title, kind }) as ViewBlock;
const field = (id: string, name: string) => ({ id, name }) as Collection["fields"][number];

const books = {
  id: "c1",
  name: "Book",
  pluralName: "Books",
  fields: [field("f1", "Title"), field("f2", "Author")],
  itemViews: [
    { id: "iv1", name: "Default", isDefault: true, layout: { blocks: [block("ib1", "Related books")] } },
    { id: "iv2", name: "Compact", isDefault: false, layout: { blocks: [] } },
  ],
} as unknown as Collection;
const sheep = { id: "c2", name: "Sheep", pluralName: "Sheep", fields: [], itemViews: [] } as unknown as Collection;

const views = [
  { id: "v1", name: "All", isDefault: true, blocks: [block("b1", "")] },
  { id: "v2", name: "Reading list", isDefault: false, blocks: [block("b2", "Open"), block("b3", "Open")] },
] as unknown as CollectionView[];
const labels: ItemLabel[] = [
  { id: "i1", label: "Dune", spaceId: "s" },
  { id: "i2", label: "Dune", spaceId: "s" },
];

const data: LinkData = {
  collections: [books, sheep],
  views: async (c) => (c.id === "c1" ? views : []),
  items: async (c) => (c.id === "c1" ? labels : [{ id: "i9", label: "Shaun", spaceId: "s" }]),
};

describe("slug", () => {
  it("is lower case with hyphens and no punctuation", () => {
    expect(slug(" Related  Books! ")).toBe("related-books");
    expect(slugs(["Open", "Open", "open"])).toEqual(["open", "open-1", "open-2"]);
  });
});

describe("parseNameLink", () => {
  it("takes only links without a scheme, anchor or query", () => {
    expect(parseNameLink("./books/Reading%20list#Open")).toEqual({ segments: ["books", "reading-list"], fragment: "open" });
    expect(parseNameLink("/books")).toEqual({ segments: ["books"], fragment: null });
    for (const other of ["https://x.org", "mailto:a@b.c", "#heading", "#/collections/c1/items", "?view=x", "//host/x", ""]) {
      expect(parseNameLink(other)).toBeNull();
    }
  });
});

describe("resolveNameLink", () => {
  it("resolves collections, views and their blocks", async () => {
    expect(await resolveNameLink("books", data)).toBe("#/collections/c1/items");
    expect(await resolveNameLink("books/reading-list", data)).toBe("#/collections/c1/items?view=v2");
    expect(await resolveNameLink("books/reading-list#open-1", data)).toBe("#/collections/c1/items?view=v2&block=b3");
    expect(await resolveNameLink("books#table", data)).toBe("#/collections/c1/items?block=b1");
    expect(await resolveNameLink("books/nothing", data)).toBeNull();
  });

  it("resolves items, their item views, fields and blocks by the singular name", async () => {
    expect(await resolveNameLink("book/dune-1", data)).toBe("#/collections/c1/items/i2");
    expect(await resolveNameLink("book/dune/compact#author", data)).toBe("#/collections/c1/items/i1?view=iv2&field=f2");
    expect(await resolveNameLink("book/dune#related-books", data)).toBe("#/collections/c1/items/i1?block=ib1");
    expect(await resolveNameLink("book/reading-list", data)).toBeNull();
    expect(await resolveNameLink("books/dune", data)).toBeNull();
    expect(await resolveNameLink("books/items/dune", data)).toBe("#/collections/c1/items/i1");
  });

  it("tries a view, then an item, when singular and plural are the same", async () => {
    expect(await resolveNameLink("sheep/shaun", data)).toBe("#/collections/c2/items/i9");
    expect(await resolveNameLink("sheep/views/shaun", data)).toBeNull();
  });

  it("reads a link that starts at an item's name as that item's, when one collection has it", async () => {
    expect(await resolveNameLink("dune/compact#author", data)).toBe("#/collections/c1/items/i1?view=iv2&field=f2");
    expect(await resolveNameLink("shaun/x", data)).toBeNull(); // Shaun has no item view x
    expect(await resolveNameLink("nobody/compact", data)).toBeNull();
  });
});

describe("describeLink", () => {
  it("gives the name form back", async () => {
    for (const name of ["books", "books/reading-list", "books/reading-list#open-1", "book/dune-1", "book/dune/compact#author", "book/dune#related-books"]) {
      const stored = await resolveNameLink(name, data);
      expect(stored).not.toBeNull();
      expect(await describeLink(stored!, data)).toBe(name);
    }
  });

  it("gives null for what is gone or not a page", async () => {
    expect(await describeLink("#/collections/zz/items", data)).toBeNull();
    expect(await describeLink("#/collections/c1/items?view=gone", data)).toBeNull();
    expect(await describeLink("https://example.org", data)).toBeNull();
  });
});

describe("links to dashboards", () => {
  const tab = (id: string, name: string, blocks: ViewBlock[], isDefault = false) => ({ id, dashboardId: "d1", name, isDefault, blocks }) as unknown as DashboardView;
  const health = { id: "d1", name: "Health" } as Dashboard;
  const tabs = [tab("t1", "Daily", [block("db1", "Chart", "chart")], true), tab("virtual:t2", "Weekly", [block("db2", "Notes", "markdown")])];
  const withDashboards: LinkData = { ...data, dashboards: [health, { id: "d2", name: "Money" } as Dashboard], tabs: async (d) => (d.id === "d1" ? tabs : []) };

  it("are written dashboards/<dashboard>/<tab>#<block>, stored by id (a copied tab by the id of the tab it copies)", async () => {
    expect(await resolveNameLink("dashboards", withDashboards)).toBe("#/dashboards");
    expect(await resolveNameLink("dashboards/health", withDashboards)).toBe("#/dashboards/d1");
    expect(await resolveNameLink("dashboards/health/daily", withDashboards)).toBe("#/dashboards/d1?view=t1");
    expect(await resolveNameLink("dashboards/health/weekly#notes", withDashboards)).toBe("#/dashboards/d1?view=t2&block=db2");
    expect(await resolveNameLink("dashboards/health#chart", withDashboards)).toBe("#/dashboards/d1?block=db1");
    for (const gone of ["dashboards/nothing", "dashboards/health/monthly", "dashboards/health#notes", "dashboards/health/daily/x"]) {
      expect(await resolveNameLink(gone, withDashboards)).toBeNull();
    }
  });

  it("are also read from a dashboard's or a view's name alone, when one page goes by it", async () => {
    expect(await resolveNameLink("health/daily", withDashboards)).toBe("#/dashboards/d1?view=t1");
    expect(await resolveNameLink("health#chart", withDashboards)).toBe("#/dashboards/d1?block=db1");
    expect(await resolveNameLink("weekly#notes", withDashboards)).toBe("#/dashboards/d1?view=t2&block=db2");
    expect(await resolveNameLink("reading-list#open-1", withDashboards)).toBe("#/collections/c1/items?view=v2&block=b3");
    // A view has nothing under it but blocks; a name of nothing stays nothing.
    expect(await resolveNameLink("weekly/x", withDashboards)).toBeNull();
    expect(await resolveNameLink("nothing/x", withDashboards)).toBeNull();
  });

  it("give the name form back", async () => {
    for (const name of ["dashboards", "dashboards/health", "dashboards/health/daily", "dashboards/health/weekly#notes", "dashboards/health#chart"]) {
      const stored = await resolveNameLink(name, withDashboards);
      expect(await describeLink(stored!, withDashboards)).toBe(name);
    }
    expect(await describeLink("#/dashboards/zz", withDashboards)).toBeNull();
    expect(await describeLink("#/dashboards/d1?view=gone", withDashboards)).toBeNull();
  });

  it("leave a collection called Dashboards its links when no dashboard fits", async () => {
    const called = { id: "c9", name: "Dashboard", pluralName: "Dashboards", fields: [], itemViews: [] } as unknown as Collection;
    const old = [{ id: "v9", name: "Old", isDefault: true, blocks: [] }] as unknown as CollectionView[];
    const both: LinkData = { ...withDashboards, collections: [...data.collections, called], views: async (c) => (c.id === "c9" ? old : data.views(c)) };
    expect(await resolveNameLink("dashboards", both)).toBe("#/collections/c9/items");
    expect(await resolveNameLink("dashboards/health", both)).toBe("#/dashboards/d1");
    expect(await resolveNameLink("dashboards/old", both)).toBe("#/collections/c9/items?view=v9");
  });
});

