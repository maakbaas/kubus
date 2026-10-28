// The server's own settings (Settings → AI and Connections in the app): the language model it offers every
// device and the sources it reads for them. Stored only on the server (its table server_settings,
// never synced) and changed through GET / PUT /api/settings with KUBUS_TOKEN. Secrets (the model's
// key, a source's password) can be set but are never sent back: a device sees whether one is set.
// Types only, so the server runs it directly with Node (as shared/sync.ts).

export interface ServerAiSettings {
  /** The API's root, e.g. https://api.openai.com/v1 (any OpenAI-style API); "" = none. */
  url: string;
  /** The model for AI fields. */
  fieldModel: string;
  /** The model for writing components; "" = the field model. */
  codeModel: string;
}

export interface ServerSourceSettings {
  /** Stable, so a source keeps its password when it is renamed. */
  id: string;
  /** What devices see and ask by, e.g. CRM: letters, digits, - and _. */
  name: string;
  /** Its connection string without the password, e.g. postgres://reader@crm-host:5432/crm; its scheme picks the connector. */
  url: string;
  /** Only these schemas' tables are offered (empty: all). */
  schemas: string[];
  /** Queries written in the app are allowed, not only its tables. */
  queries: boolean;
  /** Longest a statement may run. */
  timeoutSeconds: number;
}

/** GET /api/settings: what is set, secrets left out. */
export interface ServerSettingsView {
  ai: ServerAiSettings & { keySet: boolean };
  sources: (ServerSourceSettings & {
    passwordSet: boolean;
    /** Its connector ("postgres"), once it has one. */
    connector?: string;
    /** Why it can't be read now (no connector for the scheme, can't connect), or a warning (a user that can write). */
    problem?: string;
    warnings?: string[];
  })[];
}

/**
 * PUT /api/settings: the settings as a whole. A secret left out (undefined) stays as it is, but
 * only while it would go to the same place (the same API address; the same host, port and user):
 * moved elsewhere it is dropped, so a stored secret can't be sent somewhere new. "" clears it.
 */
export interface ServerSettingsUpdate {
  ai: ServerAiSettings & { key?: string };
  sources: (ServerSourceSettings & { password?: string })[];
}

/** A source's name: what /api/sources/<name> takes. */
export const SOURCE_NAME = /^[A-Za-z0-9_-]{1,40}$/;
