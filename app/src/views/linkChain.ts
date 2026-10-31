import { createContext, useContext } from "react";

/** The links a block is shown inside, outermost first (`blockLinkKey`, domain/linkedBlocks.ts): none outside a linked block. */
export const LinkChain = createContext<string[]>([]);

/** Whether a block is shown through a linked block (its settings and own content, a Markdown block's text, are the original's). */
export const useLinked = () => useContext(LinkChain).length > 0;
