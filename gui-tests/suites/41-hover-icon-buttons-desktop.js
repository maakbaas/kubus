// Hover every icon button of nine pages on a desktop window: its tooltip stays in the window and covers nothing important.
// (the crawl itself is in lib/crawl.js)

for (const [from, to] of [[0, 2], [2, 3], [3, 4], [4, 5], [5, 7], [7, 9]]) hoverTests("desktop", from, to);
