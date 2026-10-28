// The Router, readJson and the file helpers that the app and the server share (shared/router.ts,
// shared/files.ts, shared/settings.ts). Their tests live here: shared/ is copied whole into the
// server's image and typechecked without vitest.
import { describe, expect, it } from "vitest";
import { fileIdsIn, FILE_ID, filesUsedBy } from "../../../../shared/files";
import { HttpError, json, readJson, Router, type ApiRequest } from "../../../../shared/router";
import { DEFAULT_MAP_STYLE, MAP_STYLE_IDS, SOURCE_NAME } from "../../../../shared/settings";

const request = (method: string, path: string, body = ""): ApiRequest => ({
  method,
  path,
  query: new URLSearchParams(),
  headers: {},
  body: async (limit) => {
    const bytes = new TextEncoder().encode(body);
    if (bytes.byteLength > limit) throw new HttpError(413, "Too large");
    return bytes;
  },
});

describe("Router", () => {
  const router = new Router()
    .add("GET", "/api/v1/items/{id}", async (_req, { id }) => json(200, { id }))
    .add("DELETE", "/api/v1/items/{id}", async () => json(200, { ok: true }))
    .add("GET", "/api/v1/a.b", async () => json(200, "dot"))
    .add("GET", "/api/v1/boom", async () => {
      throw new HttpError(418, "teapot");
    })
    .add("GET", "/api/v1/crash", async () => {
      throw new Error("bug");
    })
    .add("GET", "/api/v1/{x}/{y}", async (_req, p) => json(200, p));

  it("runs the route of the method and path, with the placeholders as parameters", async () => {
    expect(await router.handle(request("GET", "/api/v1/items/abc"))).toEqual({ status: 200, json: { id: "abc" } });
    expect(await router.handle(request("DELETE", "/api/v1/items/abc"))).toEqual({ status: 200, json: { ok: true } });
  });

  it("decodes percent-encoded parameters, and a placeholder matches one segment only", async () => {
    expect((await router.handle(request("GET", "/api/v1/items/a%20b%2Fc"))).json).toEqual({ id: "a b/c" });
    expect((await router.handle(request("GET", "/api/v1/items/a/b"))).status).toBe(404); // a slash is not a segment
    expect((await router.handle(request("GET", "/api/v1/q/r"))).json).toEqual({ x: "q", y: "r" });
  });

  it("matches a path's special characters literally", async () => {
    expect((await router.handle(request("GET", "/api/v1/a.b"))).json).toBe("dot");
    expect((await router.handle(request("GET", "/api/v1/aXb"))).status).toBe(404);
  });

  it("answers 404 for an unknown path and 405 for a known one with another method", async () => {
    expect(await router.handle(request("GET", "/nothing"))).toEqual({ status: 404, json: { error: "Not found" } });
    expect(await router.handle(request("POST", "/api/v1/items/abc"))).toEqual({ status: 405, json: { error: "Method not allowed" } });
  });

  it("answers HEAD from a GET route, but not from a route of another method", async () => {
    expect((await router.handle(request("HEAD", "/api/v1/items/abc"))).status).toBe(200);
    expect((await new Router().add("POST", "/p", async () => json(200, 1)).handle(request("HEAD", "/p"))).status).toBe(405);
  });

  it("turns an HttpError into its status and { error }, and lets any other error through", async () => {
    expect(await router.handle(request("GET", "/api/v1/boom"))).toEqual({ status: 418, json: { error: "teapot" } });
    await expect(router.handle(request("GET", "/api/v1/crash"))).rejects.toThrow("bug");
  });

  it("knows whether some route has a path, with any method", () => {
    expect(router.has("/api/v1/items/abc")).toBe(true);
    expect(router.has("/api/v1/items")).toBe(false);
    expect(router.has("/elsewhere")).toBe(false);
  });
});

describe("readJson", () => {
  it("parses a JSON body, and gives undefined for an empty one", async () => {
    expect(await readJson(request("POST", "/", '{"a":[1,2]}'), 100)).toEqual({ a: [1, 2] });
    expect(await readJson(request("POST", "/", ""), 100)).toBeUndefined();
  });

  it("answers 400 for a body that isn't JSON", async () => {
    await expect(readJson(request("POST", "/", "{nope"), 100)).rejects.toMatchObject({ status: 400, message: "The body isn't valid JSON" });
  });

  it("passes on the request's refusal of a body beyond the limit", async () => {
    await expect(readJson(request("POST", "/", '{"long":"xxxxxxxxxx"}'), 5)).rejects.toMatchObject({ status: 413 });
  });
});

describe("file ids", () => {
  const a = "a".repeat(64);
  const b = "0123456789abcdef".repeat(4);

  it("are 64 lower-case hex digits", () => {
    expect(FILE_ID.test(a)).toBe(true);
    expect(FILE_ID.test(a.toUpperCase())).toBe(false);
    expect(FILE_ID.test(a.slice(1))).toBe(false);
    expect(FILE_ID.test(`${a}0`)).toBe(false);
  });

  it("are found in text as files/<id>, each once", () => {
    expect(fileIdsIn(`![](files/${a}) and <img src="files/${b}"> again files/${a}`)).toEqual([a, b]);
    expect(fileIdsIn("no files/ here, nor files/short")).toEqual([]);
  });

  it("are the image values and the ids in text that rows use", () => {
    expect(
      filesUsedBy([{ value_file: a }, { value_text: `see files/${b}` }, { value_text: "plain", value_file: null }, { value_text: null }, { value_file: 5 }, { value_file: a }]).sort(),
    ).toEqual([a, b].sort());
    expect(filesUsedBy([])).toEqual([]);
  });
});

describe("settings", () => {
  it("names a source in single-spaced words of letters, digits, - and _", () => {
    for (const ok of ["CRM", "my db", "a-b_c 1", "x".repeat(40)]) expect(SOURCE_NAME.test(ok), ok).toBe(true);
    for (const bad of ["", " lead", "trail ", "two  spaces", "dot.ted", "slash/ed", "x".repeat(41), "é"]) expect(SOURCE_NAME.test(bad), bad).toBe(false);
  });

  it("offers the map styles, starting from the one that follows the theme", () => {
    expect(MAP_STYLE_IDS).toContain(DEFAULT_MAP_STYLE);
    expect(DEFAULT_MAP_STYLE).toBe("auto");
  });
});
