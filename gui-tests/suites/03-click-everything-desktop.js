// Click everything on a desktop window: every visible control of the main pages is clicked (and what it opens, one level down); audit after each.
// (the crawl itself is in lib/crawl.js)

clickTests("desktop", ["collections", "collection table", "collection cards", "collection blocks", "item page", "new item", "collection editor", "component editor", "settings sync", "search"], { smoke: ["collections"] });
