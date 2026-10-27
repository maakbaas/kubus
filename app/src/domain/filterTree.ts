// How a filter's rules combine: And narrows what comes before a rule, Or lets more in, read in
// order (no precedence: "A or B and C" is "(A or B) and C"). A block builds on the filter above it
// (its view's, or its item page's): its rules come after that filter's, so its And rules tighten it
// and its Or rules make exceptions to it. A filter's date period frames that filter: it is and-ed
// with the filter's other rules (and what that filter builds on), wherever it sits in the list.
// The result is a condition tree, checked here (applyQuery) and sent as is to remote sources
// (shared/sources.ts), so every connector filters the same way.

import type { FilterRule } from "./query";

/** A rule, or all (`and`) / any (`or`) of several; `{ and: [] }` matches everything, `{ or: [] }` nothing. */
export type FilterTree<L> = L | { and: FilterTree<L>[] } | { or: FilterTree<L>[] };

const isAnd = <L,>(t: FilterTree<L>): t is { and: FilterTree<L>[] } => typeof t === "object" && t !== null && "and" in t;
const isOr = <L,>(t: FilterTree<L>): t is { or: FilterTree<L>[] } => typeof t === "object" && t !== null && "or" in t;

/** `a and b` / `a or b`, flat while the operator repeats. */
function combine<L>(op: "and" | "or", a: FilterTree<L>, b: FilterTree<L>): FilterTree<L> {
  if (op === "and") return { and: [...(isAnd(a) ? a.and : [a]), b] };
  return { or: [...(isOr(a) ? a.or : [a]), b] };
}

/**
 * The tree of filters building on each other, outermost first (a view's or item page's, then a
 * block's); null when nothing filters. Only the rules `counts` keeps take part (one without its
 * value yet, or on a field that is gone, joins nothing), so a half-written Or rule never lets
 * everything through.
 */
export function filterTree<R extends FilterRule>(layers: R[][], counts: (rule: R) => boolean = () => true): FilterTree<R> | null {
  let tree: FilterTree<R> | null = null;
  for (const layer of layers) {
    const rules = layer.filter(counts);
    // The date period: the first "between" rule (DatePeriodFilter's), and-ed with the rest.
    const period = rules.find((r) => r.operator === "between");
    for (const rule of rules) {
      if (rule === period) continue;
      tree = tree === null ? rule : combine(rule.join === "or" ? "or" : "and", tree, rule);
    }
    if (period) tree = tree === null ? period : { and: [period, ...(isAnd(tree) ? tree.and : [tree])] };
  }
  return tree;
}

/** Whether a tree holds (null: nothing filters), its rules checked by `test`. */
export function holds<L>(tree: FilterTree<L> | null, test: (rule: L) => boolean): boolean {
  if (tree === null) return true;
  if (isAnd(tree)) return tree.and.every((t) => holds(t, test));
  if (isOr(tree)) return tree.or.some((t) => holds(t, test));
  return test(tree);
}

/** The tree with each rule replaced (`{ or: [] }` for one that can never match). */
export function mapTree<L, M>(tree: FilterTree<L>, map: (rule: L) => FilterTree<M>): FilterTree<M> {
  if (isAnd(tree)) return { and: tree.and.map((t) => mapTree(t, map)) };
  if (isOr(tree)) return { or: tree.or.map((t) => mapTree(t, map)) };
  return map(tree);
}

/** The rules every passing item meets (reached through `and` alone): what a new item can be given. */
export function requiredRules<L>(tree: FilterTree<L> | null): L[] {
  if (tree === null || isOr(tree)) return [];
  if (isAnd(tree)) return tree.and.flatMap((t) => requiredRules(t));
  return [tree];
}
