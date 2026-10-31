// List of numbers fields: a JSON array of numbers in value_json, in the order typed.

/** A list of numbers as stored or given (numbers, or text of numbers); entries that aren't finite numbers are dropped. */
export function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((x) => {
    const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
    return Number.isFinite(n) ? [n] : [];
  });
}
