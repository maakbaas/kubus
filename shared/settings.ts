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
  /** Its kind (a ConnectionKind's id, e.g. "postgres"): picks the connector. */
  kind: string;
  /** That kind's fields (its password aside), e.g. { host, port, database, user, ssl }. */
  fields: Record<string, string>;
  /** Only these schemas' tables are offered (empty: all). */
  schemas: string[];
  /** Queries written in the app are allowed, not only its tables. */
  queries: boolean;
  /** Longest a statement may run. */
  timeoutSeconds: number;
}

/** One box of a kind of connection (see ConnectionKind). */
export interface ConnectionField {
  key: string;
  label: string;
  placeholder?: string;
  helperText?: string;
  /** A choice of these (the first is the default) instead of a text box. */
  choices?: { value: string; text: string }[];
}

/**
 * A kind of source the server can read, as the app sets it up: its own fields, what its password is called, and what its schemas are (null:
 * it has none). Described by the server (server/src/connectors/kinds.ts), so the app knows no database.
 */
export interface ConnectionKind {
  /** E.g. "postgres". */
  id: string;
  label: string;
  fields: ConnectionField[];
  password: { label: string; helperText: string };
  schemas: { label: string; helperText: string } | null;
}

/** GET /api/settings: what is set, secrets left out. */
export interface ServerSettingsView {
  ai: ServerAiSettings & { keySet: boolean };
  /** The kinds of source it can read. */
  kinds: ConnectionKind[];
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
 * only while it would go to the same place (the same API address; for a source, the same kind and the fields its password belongs to: host, port and user, an address, an account):
 * moved elsewhere it is dropped, so a stored secret can't be sent somewhere new. "" clears it.
 */
export interface ServerSettingsUpdate {
  ai: ServerAiSettings & { key?: string };
  sources: (ServerSourceSettings & { password?: string })[];
}

/** A source's name: what /api/sources/<name> takes. */
export const SOURCE_NAME = /^[A-Za-z0-9_-]{1,40}$/;
