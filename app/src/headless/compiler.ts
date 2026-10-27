import vm from "node:vm";
import type { Compiler } from "../domain/components";

// Component code on the server: compiled into a V8 context of its own, which has the language's
// built-ins (Math, JSON, Date, Intl, …) but none of Node's (process, require, fetch), may not
// compile strings (eval, new Function), and gets a time limit per run, so an endless loop fails
// the value instead of stopping the server. This is not a security boundary: the values handed in
// ($item and the rest) come from the server's own context. Whoever holds the token can run code
// on the server, as they can change all data.

const TIME_LIMIT_MS = 1000;

const context = vm.createContext({}, { name: "components", codeGeneration: { strings: false, wasm: false } });
const call = new vm.Script("__kubus.fn.apply(null, __kubus.args)");

/** An error or a date made in the context, as the server's own (instanceof checks work on them). */
function ours(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Date]") return new Date((value as Date).getTime());
  if (tag === "[object Error]" && !(value instanceof Error)) return new Error(String((value as Error).message));
  return value;
}

export const contextCompiler: Compiler = (params, body) => {
  let fn: unknown;
  try {
    fn = vm.compileFunction(body, params, { parsingContext: context });
  } catch (e) {
    throw ours(e);
  }
  return (...args: unknown[]) => {
    (context as { __kubus?: unknown }).__kubus = { fn, args };
    try {
      return ours(call.runInContext(context, { timeout: TIME_LIMIT_MS }));
    } catch (e) {
      const error = ours(e);
      if (error instanceof Error && /timed out/i.test(error.message)) throw new Error(`Took longer than ${TIME_LIMIT_MS / 1000} s`);
      throw error;
    } finally {
      delete (context as { __kubus?: unknown }).__kubus;
    }
  };
};
