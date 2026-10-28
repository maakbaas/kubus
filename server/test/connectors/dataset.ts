// The rows the connectors' real-service tests load into each service (through its own API) and expect
// back: the same few people everywhere, with the values that trip a connector up (blank and missing
// values, case and accents, numbers inside text, SQL and regular-expression characters, quotes, a time
// near midnight so that a time zone moves its day, list values).
export interface Person {
  id: number;
  name: string | null;
  age: number | null;
  score: number | null;
  active: boolean | null;
  /** yyyy-mm-dd */
  born: string | null;
  /** ISO 8601 UTC */
  seen: string | null;
  tags: string[] | null;
  city: string | null;
}

export const PEOPLE: Person[] = [
  { id: 1, name: "Ada", age: 36, score: 9.5, active: true, born: "1815-12-10", seen: "2026-03-01T23:30:00.000Z", tags: ["math", "poetry"], city: "Amsterdam" },
  { id: 2, name: "bob", age: 41, score: 7.25, active: false, born: "1980-01-01", seen: "2026-03-02T08:00:00.000Z", tags: ["music"], city: "Berlin" },
  { id: 3, name: "", age: null, score: null, active: null, born: null, seen: null, tags: [], city: null },
  { id: 4, name: "Émile", age: 7, score: 1, active: true, born: "2020-05-05", seen: "2026-03-01T10:00:00.000Z", tags: ["math"], city: "Amsterdam" },
  { id: 5, name: "Customer 10", age: -3, score: -0.5, active: false, born: "2026-12-31", seen: "2026-12-31T23:59:00.000Z", tags: null, city: "Cairo" },
  { id: 6, name: "Customer 9", age: 100, score: 1000000, active: true, born: "1999-01-01", seen: "2026-01-01T00:00:00.000Z", tags: ["Music"], city: "Amsterdam" },
  { id: 7, name: "100% sure", age: 0, score: 0, active: false, born: "2000-02-29", seen: "2026-03-01T10:00:00.000Z", tags: ["a,b"], city: "Berlin" },
  { id: 8, name: "under_score", age: 7, score: 2.5, active: true, born: "2001-03-04", seen: "2026-03-03T12:00:00.000Z", tags: ["math", "music"], city: "berlin" },
  { id: 9, name: "O'Brien", age: 50, score: 3, active: false, born: "1950-06-15", seen: "2026-06-15T12:00:00.000Z", tags: ["poetry"], city: "Cairo" },
  { id: 10, name: "zoë", age: 12, score: 4.75, active: true, born: "2014-07-08", seen: "2026-03-01T14:00:00.000Z", tags: [], city: null },
  { id: 11, name: "ZOE", age: 12, score: 4.75, active: false, born: "2014-07-08", seen: "2026-03-02T00:00:00.000Z", tags: ["math"], city: "Cairo" },
  { id: 12, name: 'Quote "d" \\ back', age: 99, score: 0.1, active: true, born: "1925-11-11", seen: "2025-11-11T11:11:00.000Z", tags: ["poetry", "math", "music"], city: "Amsterdam" },
  { id: 13, name: null, age: 50, score: 3, active: true, born: "1950-06-15", seen: "2026-06-14T22:30:00.000Z", tags: null, city: "Berlin" },
  { id: 14, name: "  padded  ", age: 1, score: 0.001, active: false, born: null, seen: "2026-03-01T23:59:59.000Z", tags: ["x"], city: "Cairo" },
];
