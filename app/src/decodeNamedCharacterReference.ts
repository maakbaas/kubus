// `decode-named-character-reference` (micromark's, so remark's and Milkdown's) as the bundle uses it: its browser build
// decoded with a DOM element made when the module loads, which throws in the database worker ("document is not defined")
// once anything reaching the Markdown parser (domain/markdownExcerpt.ts, through domain/query.ts) is imported there. The same
// decoding, with the element made on the first call, keeps every domain module safe to load in a worker; the worker never
// decodes Markdown. vite.config.ts aliases the package to this file (tests and the headless device run on node, which takes
// its non-DOM build).

let element: HTMLElement | undefined;

/** The character a named reference ("amp", "not") stands for, or false when it is none. */
export function decodeNamedCharacterReference(value: string): string | false {
  const reference = `&${value};`;
  element ??= document.createElement("i");
  element.innerHTML = reference;
  const character = element.textContent ?? "";
  // Some references need no closing semicolon (`&not`): `&notit;` reads as `¬it;`, which is no match.
  if (character.charCodeAt(character.length - 1) === 59 /* ; */ && value !== "semi") return false;
  // Unchanged: no reference.
  return character === reference ? false : character;
}
