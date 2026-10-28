// @vitest-environment node
// The CSV and JSON connectors reading the dataset's people from real files over a real HTTP server (httpFiles.ts),
// asked the shared contract's questions (contract.ts): as CSV (comma and semicolon), JSON, NDJSON and JSON at a pointer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "vitest";
import { CsvConnector } from "../../src/connectors/csv.ts";
import { forgetDocuments } from "../../src/connectors/httpDocument.ts";
import { IcsConnector } from "../../src/connectors/ics.ts";
import { JsonConnector } from "../../src/connectors/json.ts";
import type { MemoryRow } from "../../src/connectors/memory.ts";
import type { SourceColumn } from "../../../shared/sources.ts";
import { runContract, type Fixture } from "./contract.ts";
import { PEOPLE, type Person } from "./dataset.ts";
import { serve, type Served } from "./httpFiles.ts";

const config = (kind: string, address: string, fields: Record<string, string> = {}) => ({ name: "Doc", kind, fields: { address, ...fields }, password: "", schemas: [], timeoutMs: 10_000 });

const csvQuote = (v: string | number | boolean | null, delimiter: string) => {
  if (v === null) return "";
  const s = String(v);
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvOf = (people: Person[], delimiter: string, decimal = ".") =>
  [
    ["id", "name", "age", "score", "active", "born", "seen", "city"].join(delimiter),
    ...people.map((p) => [p.id, p.name, p.age, p.score === null ? null : String(p.score).replace(".", decimal), p.active, p.born, p.seen, p.city].map((v) => csvQuote(v, delimiter)).join(delimiter)),
  ].join("\r\n") + "\r\n";

const columns = (lists: boolean): SourceColumn[] => [
  { name: "id", type: "number", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "age", type: "number", kind: "number" },
  { name: "score", type: "number", kind: "number" },
  { name: "active", type: "boolean", kind: "checkbox" },
  { name: "born", type: "date", kind: "date" },
  { name: "seen", type: "datetime", kind: "datetime" },
  ...(lists ? [{ name: "tags", type: "list", kind: "string_list" as const }] : []),
  { name: "city", type: "text", kind: "string" },
];

/** A text as an ICS value (RFC 5545, 3.3.11). */
const icsText = (v: string) => v.replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
const icsStamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** The people who have a time, as events of a calendar (the rest can't be: an event starts). */
const icsOf = (people: Person[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kubus test//EN",
    ...people
      .filter((p) => p.seen)
      .flatMap((p) => [
        "BEGIN:VEVENT",
        `UID:p${p.id}@example.com`,
        "DTSTAMP:20260101T000000Z",
        `DTSTART:${icsStamp(p.seen!)}`,
        ...(p.name ? [`SUMMARY:${icsText(p.name)}`] : []),
        ...(p.city ? [`LOCATION:${icsText(p.city)}`] : []),
        ...(p.tags?.length ? [`CATEGORIES:${p.tags.map(icsText).join(",")}`] : []),
        "END:VEVENT",
      ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");

describe("CSV, JSON and ICS connectors, reading real files over HTTP, asked the shared contract", () => {
  let dir: string;
  let served: Served;
  const fixtures: Record<string, Fixture> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kubus-http-"));
    mkdirSync(dir, { recursive: true });
    // A CSV has no empty text but a missing one; a number or date is text until a column's values all are.
    const flat: MemoryRow[] = PEOPLE.map(({ tags: _t, ...p }) => ({ ...p, name: p.name === "" ? null : p.name }));
    writeFileSync(join(dir, "people.csv"), csvOf(PEOPLE, ","));
    writeFileSync(join(dir, "people-semicolon.csv"), "﻿" + csvOf(PEOPLE, ";", ","));
    writeFileSync(join(dir, "people.json"), JSON.stringify(PEOPLE));
    writeFileSync(join(dir, "people.ndjson"), PEOPLE.map((p) => JSON.stringify(p)).join("\n") + "\n");
    writeFileSync(join(dir, "wrapped.json"), JSON.stringify({ meta: { n: PEOPLE.length }, data: { people: PEOPLE } }));
    writeFileSync(join(dir, "people.ics"), icsOf(PEOPLE));
    served = await serve(dir);
    forgetDocuments();
    const target = (name: string) => ({ table: { schema: null, name } });
    const make = (connector: Fixture["connector"], name: string, lists: boolean, rows: MemoryRow[]): Fixture => ({
      connector,
      target: target(name),
      columns: columns(lists),
      rows,
      key: "id",
      title: ["name", "city"],
    });
    const jsonRows: MemoryRow[] = PEOPLE.map((p) => ({ ...p }));
    fixtures.csv = make(new CsvConnector(config("csv", `${served.base}/people.csv`)), "rows", false, flat);
    fixtures.semicolon = make(new CsvConnector(config("csv", `${served.base}/people-semicolon.csv`)), "rows", false, flat);
    fixtures.json = make(new JsonConnector(config("json", `${served.base}/people.json`)), "rows", true, jsonRows);
    fixtures.ndjson = make(new JsonConnector(config("json", `${served.base}/people.ndjson`)), "rows", true, jsonRows);
    fixtures.wrapped = make(new JsonConnector(config("json", `${served.base}/wrapped.json`, { rows: "/data/people" })), "people", true, jsonRows);
    // Events: the title is the name (none: none), the start the moment last seen (a person never seen has no event).
    const events = PEOPLE.filter((p) => p.seen);
    fixtures.ics = {
      connector: new IcsConnector(config("ics", `${served.base}/people.ics`)),
      target: target("events"),
      columns: [
        { name: "title", type: "SUMMARY", kind: "string" },
        { name: "start", type: "DTSTART", kind: "datetime" },
        { name: "start date", type: "DTSTART", kind: "date" },
        { name: "location", type: "LOCATION", kind: "string" },
        { name: "categories", type: "CATEGORIES", kind: "string_list" },
        { name: "all-day", type: "VALUE=DATE", kind: "checkbox" },
        { name: "uid", type: "UID", kind: "string", hidden: true },
      ],
      rows: events.map((p) => ({ title: p.name || null, start: p.seen, "start date": p.seen!.slice(0, 10), location: p.city, categories: p.tags ?? [], "all-day": false, uid: `p${p.id}@example.com` })),
      key: "uid",
      describedKey: ["id"],
      title: ["title", "location"],
    };
  });

  afterAll(async () => {
    await served?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const name of ["csv", "semicolon", "json", "ndjson", "wrapped", "ics"]) {
    describe(name, () => {
      runContract(() => fixtures[name]);
    });
  }
});
