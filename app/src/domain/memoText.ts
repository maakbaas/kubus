// Text worked out from a value (the plain text of Markdown or HTML), remembered by the value: filtering, sorting and
// searching ask for the same values over and over (a view's search each keystroke, over every item).

/**
 * `fn`, remembering up to `max` results by their input; the least recently used go first. Room for a large collection's
 * values: a pass over more than it holds would find none of them in it.
 */
export function memoText(fn: (source: string) => string, max = 20_000): (source: string) => string {
  const results = new Map<string, string>();
  return (source) => {
    let text = results.get(source);
    if (text === undefined) {
      text = fn(source);
      if (results.size >= max) results.delete(results.keys().next().value!);
    } else results.delete(source);
    results.set(source, text);
    return text;
  };
}
