// Click everything on a desktop window: every visible control of 16 pages is clicked (and what it opens, one level down); audit after each.
// (the crawl itself is in lib/crawl.js)

clickTests("desktop", ["collections", "collection table", "collection cards", "collection blocks", "item page", "new item", "collection editor", "components", "component editor", "spaces", "bookmarks", "settings server", "settings sync", "settings AI", "settings API tokens", "search"], { smoke: ["collections"] });
