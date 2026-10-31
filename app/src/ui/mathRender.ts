// KaTeX for formulas in Markdown ($…$, $$…$$, ```math: GitHub's math, the one addition to GFM; remark-math parses it in
// MarkdownView and the editor). Its own module, loaded the first time a text has math in it: KaTeX and its fonts stay
// out of the app's start, and are bundled (no CDN), so formulas render offline too.
import "katex/dist/katex.min.css";
import rehypeKatex from "rehype-katex";
import type { Pluggable } from "unified";

/** A formula KaTeX can't read is shown as its source in the error colour, never thrown. */
export const rehypeMath: Pluggable = [rehypeKatex, { throwOnError: false, strict: "ignore", errorColor: "var(--cds-text-error)" }];
