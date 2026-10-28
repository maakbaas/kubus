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
  /** What devices see and ask by, e.g. CRM: letters, digits, spaces, - and _ (renamed, it is still asked for by its former names). */
  name: string;
  /** Its kind (a ConnectionKind's id, e.g. "postgres"): picks the connector. */
  kind: string;
  /** That kind's fields (its password and secret fields aside), e.g. { host, port, database, user, ssl }. */
  fields: Record<string, string>;
  /** Only these schemas' tables are offered (empty: all). */
  schemas: string[];
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
  /**
   * Kept like the password (a second secret: a budget's encryption password): stored on the server only,
   * never sent back (a device sees whether it is set), kept while left out of an update, dropped when the
   * source's place changes. Addresses are never secret: a secret in one is a field of its own ({secret}).
   */
  secret?: boolean;
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
    /** The secret fields that are set (their keys). */
    secretsSet: string[];
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
 * moved elsewhere it is dropped, so a stored secret can't be sent somewhere new. "" clears it. A secret field
 * (ConnectionField.secret) is the same.
 */
export interface ServerSettingsUpdate {
  ai: ServerAiSettings & { key?: string };
  /** `secrets`: the secret fields to set ("" clears one); one left out is kept like the password. */
  sources: (ServerSourceSettings & { password?: string; secrets?: Record<string, string> })[];
}

/** A source's name: what /api/sources/<name> takes (single spaces between words). */
export const SOURCE_NAME = /^(?=.{1,40}$)[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/;
