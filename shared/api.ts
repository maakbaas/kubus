// How the server and the headless device (app/src/headless, bundled into server/headless by
// `npm run build:headless`) talk: the server loads the bundle and calls `startHeadless`. Types
// only (see shared/sync.ts).

import type { ApiRequest, ApiResponse } from "./router.ts";

/** What the server gives the headless device. */
export interface HeadlessOptions {
  /** The server itself, e.g. http://127.0.0.1:8080: the headless device syncs over HTTP like any device. */
  serverUrl: string;
  token: string;
  /** The server's file clean-up (server/src/files.ts); the headless device decides what is unused. */
  files: {
    marked(cutoff: Date): Promise<string[]>;
    unmark(ids: string[]): Promise<void>;
    /** Deletes those still marked since before `cutoff`; returns the deleted ids. */
    delete(ids: string[], cutoff: Date): Promise<string[]>;
  };
  /** How long a file stays unused before it is deleted, and how often that is checked. */
  unusedFileDays: number;
  cleanUpEveryMs: number;
  /** Webhooks: called with every change (docs/sync.md). */
  webhooks: { urls: string[]; secret: string | null };
  log(message: string): void;
}

export interface Headless {
  /** Answers a request to /api/v1 (one at a time, each on the latest data). */
  handle(req: ApiRequest): Promise<ApiResponse>;
}

/** The headless bundle's export. */
export type StartHeadless = (options: HeadlessOptions) => Promise<Headless>;

/**
 * The language model the server offers its devices (GET /api/ai): set by its KUBUS_AI_*
 * variables. Devices call it through the server (/api/ai/chat/completions, /api/ai/models with
 * KUBUS_TOKEN), so the provider's key never leaves the server.
 */
export interface ServerAi {
  available: boolean;
  /** The model for AI fields. */
  fieldModel: string;
  /** The model for writing components; empty = the field model. */
  codeModel: string;
}
