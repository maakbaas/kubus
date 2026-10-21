import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { refractor } from "refractor";
import type { ElementContent, Root, RootContent } from "hast";
import type { Nodes as MdNodes, Root as MdRoot } from "mdast";
import { Link } from "@carbon/react";
import { fileIdFromSrc } from "../domain/files";
import { openExternal } from "../platform/openExternal";
import { splitWarnings } from "../domain/templates";
import { matcher, splitMatches } from "./Highlight";
import { TemplateWarning } from "./TemplateWarning";
import { UrlImage, useFileUrl } from "./images";

// Read-only GFM rendering (remark-gfm, the same parser family Milkdown uses).
// Raw HTML is skipped, so stored content can't inject markup.
//  - "full": the object view; links are clickable (system browser).
//  - "excerpt": search results, rendered inside clickable list items, so it has no
//    interactive elements (links are styled text) and is clipped in height.

/** rehype plugin: colors fenced code with refractor (same tokens/CSS as the editor's prism plugin). */
function rehypeCodeColor() {
  return (tree: Root) => {
    const walk = (nodes: RootContent[]) => {
      for (const node of nodes) {
        if (node.type !== "element") continue;
        const code = node.tagName === "pre" ? node.children.find((c) => c.type === "element" && c.tagName === "code") : undefined;
        if (code?.type === "element") {
          const classes = (code.properties.className as string[] | undefined) ?? [];
          const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
          if (lang && refractor.registered(lang)) {
            const text = code.children.map((c) => (c.type === "text" ? c.value : "")).join("");
            code.children = refractor.highlight(text, lang).children as ElementContent[];
          }
        } else {
          walk(node.children);
        }
      }
    };
    walk(tree.children);
  };
}

/**
 * remark plugin: the editor stores an empty paragraph (a blank line the user typed) as a raw
 * `<br />` line. Render exactly that as an empty paragraph (or a line break inside text), like
 * the editor shows it; every other piece of raw HTML is dropped, so content can't inject markup.
 */
function remarkEditorBreaks() {
  const isBreak = (html: string) => /^<br\s*\/?>$/i.test(html.trim());
  const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);
  return (tree: MdRoot) => {
    const walk = (node: MdNodes) => {
      if (!("children" in node)) return;
      const block = BLOCK_PARENTS.has(node.type);
      (node as { children: MdNodes[] }).children = (node.children as MdNodes[]).flatMap((child): MdNodes[] => {
        if (child.type === "html") {
          if (!isBreak(child.value)) return [];
          return block ? [{ type: "paragraph", children: [{ type: "break" }] }] : [{ type: "break" }];
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}

/**
 * rehype plugin: newlines in text become what GFM (and the editor) show. The view uses
 * `white-space: break-spaces` to wrap exactly like the editor, which would otherwise
 * render every source newline as a line break:
 *  - the "\n" after a hard break (<br>) is dropped, it would add an empty line;
 *  - soft breaks (a single newline inside a paragraph) become spaces.
 * Code blocks keep their newlines.
 */
function rehypeSoftBreaks() {
  return (tree: Root) => {
    const walk = (nodes: RootContent[]) => {
      nodes.forEach((node, i) => {
        if (node.type === "text") {
          const prev = nodes[i - 1];
          const afterBreak = prev?.type === "element" && prev.tagName === "br";
          // The space after a task checkbox would show (break-spaces); the editor has none.
          const afterTask = prev?.type === "element" && prev.tagName === "input";
          node.value = (afterBreak ? node.value.replace(/^\n/, "") : afterTask ? node.value.replace(/^ /, "") : node.value).replace(/\n/g, " ");
        } else if (node.type === "element" && node.tagName !== "pre") {
          walk(node.children);
        }
      });
    };
    walk(tree.children);
  };
}

/** rehype plugin: the warnings of failing template sections in text become warning spans. */
function rehypeWarnings() {
  return (tree: Root) => {
    const walk = (children: RootContent[]): RootContent[] =>
      children.flatMap((child): RootContent[] => {
        if (child.type === "text") {
          const parts = splitWarnings(child.value);
          if (parts.length === 1) return [child];
          return parts.map((part, i) =>
            i % 2 === 1
              ? { type: "element", tagName: "span", properties: { className: ["template-warning-text"] }, children: [{ type: "text", value: part }] }
              : { type: "text", value: part },
          );
        }
        if (child.type === "element") child.children = walk(child.children) as ElementContent[];
        return [child];
      });
    tree.children = walk(tree.children);
  };
}

/** rehype plugin: wraps every match of `query` in text nodes with <mark>. */
function rehypeMark(query: string) {
  return () => (tree: Root) => {
    const re = matcher(query);
    if (!re) return;
    const walk = (children: RootContent[]): RootContent[] =>
      children.flatMap((child): RootContent[] => {
        if (child.type === "text") {
          return splitMatches(child.value, re).map((part, i) =>
            i % 2 === 1
              ? { type: "element", tagName: "mark", properties: { className: ["search-mark"] }, children: [{ type: "text", value: part }] }
              : { type: "text", value: part },
          );
        }
        if (child.type === "element") child.children = walk(child.children) as ElementContent[];
        return [child];
      });
    tree.children = walk(tree.children);
  };
}

function StoredImage({ src, alt }: { src?: string; alt?: string }) {
  const fileId = fileIdFromSrc(src ?? "");
  const url = useFileUrl(fileId);
  if (fileId) return url ? <img src={url} alt={alt ?? ""} /> : null;
  // An image from elsewhere (e.g. a template's URL) may be missing: then a placeholder says so.
  return src ? <UrlImage url={src} /> : null;
}

/** Where the task item around a checkbox starts in the source, and how to toggle it there. */
const TaskContext = createContext<{ offset?: number; toggle?(offset: number): void }>({});

function TaskBox({ checked }: { checked?: boolean }) {
  const { offset, toggle } = useContext(TaskContext);
  const data = checked ? "true" : "false";
  if (!toggle || offset == null) return <span className="md-view__task" data-checked={data} />;
  // Toggles in place, without switching the field to its editor.
  return (
    <span
      className="md-view__task md-view__task--toggle"
      data-checked={data}
      role="checkbox"
      aria-checked={!!checked}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        toggle(offset);
      }}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        toggle(offset);
      }}
    />
  );
}

function TaskOffset({ offset, children }: { offset: number; children: ReactNode }) {
  const { toggle } = useContext(TaskContext);
  return <TaskContext.Provider value={{ offset, toggle }}>{children}</TaskContext.Provider>;
}

const common: Components = {
  span: ({ node: _node, className, children, ...props }) =>
    className === "template-warning-text" ? (
      <TemplateWarning>{children}</TemplateWarning>
    ) : (
      <span className={className} {...props}>
        {children}
      </span>
    ),
  img: ({ src, alt }) => <StoredImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  input: ({ checked }) => <TaskBox checked={checked} />,
};

const excerptComponents: Components = {
  ...common,
  a: ({ children }) => <span className="md-view__link">{children}</span>,
};

const fullComponents: Components = {
  ...common,
  // A task item tells its checkbox where it starts in the source (for toggling).
  li: ({ node, children, ...props }) => {
    const offset = node?.position?.start.offset;
    const task = offset != null && String(props.className ?? "").includes("task-list-item");
    return <li {...props}>{task ? <TaskOffset offset={offset}>{children}</TaskOffset> : children}</li>;
  },
  a: ({ href, children }) => (
    <Link
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternal(href);
      }}
    >
      {children}
    </Link>
  ),
};

interface Props {
  source: string;
  highlight?: string;
  variant?: "full" | "excerpt";
  /** Makes task checkboxes clickable: called with the source, that one checkbox toggled. */
  onChange?(source: string): void;
}

/** Rendered markdown; only re-rendered when its source or options change (it parses each time). */
export const MarkdownView = memo(function MarkdownView({ source, highlight = "", variant = "full", onChange }: Props) {
  const tasks = useMemo(
    () => ({
      toggle: onChange
        ? (offset: number) => {
            // The item's first [ ] / [x] after its marker is its checkbox.
            const m = /\[( |x|X)\]/.exec(source.slice(offset));
            if (!m) return;
            const at = offset + m.index + 1;
            onChange(source.slice(0, at) + (m[1] === " " ? "x" : " ") + source.slice(at + 1));
          }
        : undefined,
    }),
    [source, onChange],
  );
  return (
    <div className={`md-editor__content md-view md-view--${variant}`}>
      <TaskContext.Provider value={tasks}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkEditorBreaks]}
          rehypePlugins={[rehypeSoftBreaks, rehypeWarnings, rehypeCodeColor, rehypeMark(highlight)]}
          components={variant === "full" ? fullComponents : excerptComponents}
          skipHtml
        >
          {source}
        </ReactMarkdown>
      </TaskContext.Provider>
    </div>
  );
});
