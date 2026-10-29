// Click everything on a phone window: every visible control of four main pages is clicked (and what it opens, one level down); audit after each.
// (the crawl itself is in lib/crawl.js)

clickTests("phone", ["collection table", "item page", "collection editor", "search"]);
