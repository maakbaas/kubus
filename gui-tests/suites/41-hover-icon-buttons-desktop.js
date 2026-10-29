// Hover every icon button of the collections, collection table and item pages on a desktop window (a phone has no hover): its tooltip stays in the window and covers nothing important.
// (the crawl itself is in lib/crawl.js)

for (const [from, to] of [[0, 2], [4, 5]]) hoverTests("desktop", from, to);
