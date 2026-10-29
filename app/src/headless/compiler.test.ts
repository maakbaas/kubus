// @vitest-environment node
// Component code on the server (compiler.ts): a V8 context of its own, without Node's globals, with a time limit.
import { describe, expect, it } from "vitest";
import { contextCompiler } from "./compiler";

const run = (params: string[], body: string, ...args: unknown[]) => contextCompiler(params, body)(...args);

describe("contextCompiler", () => {
  it("compiles a function over named parameters and calls it with its arguments", () => {
    expect(run(["a", "b"], "return a * b + 1", 6, 7)).toBe(43);
    const twice = contextCompiler(["x"], "return x * 2");
    expect([twice(1), twice(5)]).toEqual([2, 10]); // callable again and again
  });

  it("has the language's built-ins, but none of Node's", () => {
    expect(run([], "return [Math.max(1, 3), JSON.stringify({ a: 1 }), typeof Intl, typeof Date]")).toEqual([3, '{"a":1}', "object", "function"]);
    expect(run([], "return [typeof process, typeof require, typeof fetch, typeof globalThis.process, typeof Buffer, typeof setTimeout]")).toEqual(Array(6).fill("undefined"));
  });

  it("refuses to compile strings: eval and new Function", () => {
    expect(() => run([], "return eval('1 + 1')")).toThrow(/code generation|EvalError|disallowed/i);
    expect(() => run([], "return new Function('return 1')()")).toThrow(/code generation|EvalError|disallowed/i);
  });

  it("gives back dates as the server's own, so instanceof works on them", () => {
    const date = run([], "return new Date(Date.UTC(2026, 9, 28))");
    expect(date).toBeInstanceOf(Date);
    expect((date as Date).toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });

  it("throws errors as the server's own", () => {
    let caught: unknown;
    try {
      run([], "throw new Error('boom')");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(() => run([], "return null.x")).toThrow(/null/);
  });

  it("reports a syntax error when compiling, as an Error", () => {
    let caught: unknown;
    try {
      contextCompiler([], "return (");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/Unexpected|token/i);
  });

  it("stops an endless loop after a second, so it fails the value instead of the server", () => {
    const started = Date.now();
    expect(() => run([], "for (;;) {}")).toThrow("Took longer than 1 s");
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(run([], "return 'still works'")).toBe("still works"); // the context is usable afterwards
  });

  it("passes plain values through untouched", () => {
    expect(run([], "return null")).toBeNull();
    expect(run([], "return 'text'")).toBe("text");
    expect(run([], "return undefined")).toBeUndefined();
  });
});
