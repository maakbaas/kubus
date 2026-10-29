// Click everything on a phone window: every visible control of 16 pages is clicked (and what it opens, one level down); audit after each.
// (the crawl itself is in lib/crawl.js)

clickTests("phone", ["collections", "collection table", "collection cards", "collection blocks", "item page", "new item", "collection editor", "components", "component editor", "spaces", "bookmarks", "settings server", "settings sync", "settings AI", "settings API tokens", "search"]);
