// Generating the values of AI fields (domain/ai.ts), in the background.
//
// Stale values are offered from two places: what shows items (`offer`, from `useAiFill`: these go
// first) and `AiBackfill` (`offerBackground`: every item of every collection with an AI field, shown
// or not, so a field added to a collection that already has items fills in by itself, and can be
// sorted and filtered on). This service runs them against the language model and stores the
// replies with `Repository.setGenerated`, whose change announcement refreshes whatever shows them.
//
// A value the user typed over is theirs: it is never made again by itself. When what its prompt reads
// changes, it is only offered (`offerOverrides`) and a modal asks whether to generate it again,
// replacing the typed text, or keep it (`progress.overrides`).
//
// More than `CONFIRM_LIMIT` values waiting, at any time (a field added to a big collection, a changed
// prompt, the app opened on a pile of stale values), stops everything until the user confirms
// (`confirm` in the progress: a modal asks); "Not now" drops them for this session. Pausing
// (settings) stops all requests, whatever waits stays queued.
//
// Rate limited: at most `CONCURRENCY` requests at once and one starting every `MIN_INTERVAL_MS`,
// whoever asked; a rate-limit answer (429) pauses everything for a while and tries the value again.
// Without a model set up everything waits, and runs once one is. A failed value is not retried by
// itself: it shows its error, and "Retry" tries again.
//
// The provider: this server's (`source: "server"`, the default when the device set none of its own:
// the server's KUBUS_AI_* variables, called through the server with the sync token, so its key stays
// there; see server/src/ai.ts), or the device's own (address, key, models in localStorage `kubus.ai`,
// never synced: the key must not travel to the server).

import type { ServerAi } from "../../../shared/api";
import type { Repository } from "../data";
import { parseAiReply, type AiRequest } from "../domain/ai";
import type { Collection, FieldDef } from "../domain/model";
import { createLlmClient, DEFAULT_LLM_SETTINGS } from "../platform/llm";
import { readPref, writePref } from "../ui/localPrefs";

const SETTINGS_KEY = "kubus.ai";
/** Requests in flight at once. */
const CONCURRENCY = 3;
/** The least time between two requests starting (40 a minute): kind to free tiers and to the bill. */
const MIN_INTERVAL_MS = 1500;
/** How long everything waits after a rate-limit answer. */
const RATE_LIMIT_PAUSE_MS = 30_000;
/** Tries per value when the provider keeps saying "too many requests". */
const MAX_ATTEMPTS = 4;
/** More values than this waiting need the user's go-ahead. */
export const CONFIRM_LIMIT = 10;
/** How long a value just generated counts as our own change (the backfill doesn't look again for it). */
const RECENT_MS = 30_000;

/** The language model settings of this device: one provider, and a model per kind of work. */
export interface AiConfig {
  /** Whose model: the sync server's (set on the server), or the device's own below. */
  source: "server" | "own";
  /** The API's root, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  apiKey: string;
  /** The model that writes the values of AI fields. */
  fieldModel: string;
  /** The model that writes components ("Write with AI"); empty = the same as for fields. */
  codeModel: string;
  /** No requests at all while on (what waits stays queued). */
  paused: boolean;
}

/** What a model is asked for: the value of an AI field, or the code of a component. */
export type AiPurpose = "field" | "code";

const DEFAULT_CONFIG: AiConfig = { source: "server", baseUrl: DEFAULT_LLM_SETTINGS.baseUrl, apiKey: "", fieldModel: "", codeModel: "", paused: false };

/** The stored settings. */
function loadConfig(): AiConfig {
  return { ...DEFAULT_CONFIG, ...readPref<Partial<AiConfig>>(SETTINGS_KEY, {}) };
}

/** Where requests go and which models they ask for (the server's or the device's own). */
export interface AiProvider {
  baseUrl: string;
  apiKey: string;
  fieldModel: string;
  codeModel: string;
}

/** What the sync server offers: its models, or why there are none (no server, not reachable, not set up). */
export interface ServerOffer {
  ai: ServerAi | null;
  problem: string | null;
}

/** How long a failed look at the server's offer is not repeated. */
const SERVER_RETRY_MS = 30_000;

export interface AiJob {
  collection: Collection;
  field: FieldDef;
  itemId: string;
  request: AiRequest;
  /** Generate even if the stored value is current (the user asked for another one). */
  force?: boolean;
  /** A nudge from the user for this one value (which of several items of the same name is meant): sent along once, not kept. */
  hint?: string;
  /** Found by the backfill (waits behind what is shown). */
  background?: boolean;
  /** The item's title, for asking about it. */
  label?: string;
  /** Times it was tried again after a rate-limit answer. */
  attempts?: number;
}

/** What the progress banner shows. */
export interface AiProgress {
  /** Waiting for a model to be set up. */
  held: number;
  /** More than CONFIRM_LIMIT values wait and nothing runs until the user says so: how many (else 0). */
  confirm: number;
  /** Requests are paused in the settings. */
  paused: boolean;
  /** Typed values whose prompt has changed since: the user is asked whether to generate them again. */
  overrides: number;
  /** One of them, as "Title · Field", to name in the question. */
  overrideSample?: string;
  /** Waiting for its turn, or being generated. */
  working: number;
  failed: number;
  lastError?: string;
  /** A model is set up (otherwise held values wait for one). */
  configured: boolean;
}

const keyOf = (itemId: string, fieldId: string) => `${itemId}:${fieldId}`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isRateLimit = (message: string) => /^429\b/.test(message) || /rate.?limit|too many requests/i.test(message);

export class AiService {
  private current: AiConfig = loadConfig();
  private offer_: ServerOffer = { ai: null, problem: null };
  /** The server and token the offer is for, and when it was last asked for. */
  private offerFor = "";
  private offerAsked = 0;
  private listeners = new Set<() => void>();
  /** Values for what is shown, and the backfill's, each in the order found; shown ones run first. */
  private queued = new Map<string, AiJob>();
  private backlog = new Map<string, AiJob>();
  private running = new Map<string, AiJob>();
  /** Shown values waiting for a model to be set up. */
  private held = new Map<string, AiJob>();
  private failed = new Map<string, { job: AiJob; message: string }>();
  /** Typed values that would be made again if they were not the user's, by key: asked about. */
  private overrides = new Map<string, AiJob>();
  /** Typed values being recorded as right for their item (`adopt`), by key and prompt. */
  private adopting = new Set<string>();
  /** Values whose prompt can't be made for the item (a broken section, a missing prompt), by key: shown in place of the value. */
  private problems = new Map<string, string>();
  /** Failures the user gave up on, by key and prompt: not tried again until the app restarts. */
  private dismissed = new Set<string>();
  private recent = new Set<string>();
  /** The user said go to what is queued; ends when the queue is empty. */
  private approved = false;
  private lastStart = 0;
  private pausedUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private progress: AiProgress;

  constructor(private repo: Repository) {
    this.progress = this.measure();
    // The server's offer follows the sync settings (and is asked for again after a failure).
    repo.sync.subscribe(() => this.refreshOffer());
    this.refreshOffer();
  }

  /** What the sync server offers (a new object whenever it changes). */
  get serverOffer(): ServerOffer {
    return this.offer_;
  }

  private setOffer(offer: ServerOffer) {
    this.offer_ = offer;
    if (this.configured) this.admit([...this.held.values()], false, true);
    this.pump();
  }

  /** Asks the sync server what model it offers (GET /api/ai), when its address or token changed. */
  private refreshOffer() {
    const { url, token } = this.repo.sync.config;
    const target = `${url}\n${token}`;
    const failed = this.offer_.problem !== null && !this.offer_.ai;
    if (target === this.offerFor && !(failed && Date.now() - this.offerAsked > SERVER_RETRY_MS)) return;
    this.offerFor = target;
    this.offerAsked = Date.now();
    if (!url || !token) return this.setOffer({ ai: null, problem: "No server is set up (Settings → Sync)." });
    fetch(`${url}/api/ai`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (target !== this.offerFor) return;
        if (!res.ok) return this.setOffer({ ai: null, problem: `The server answered ${res.status}.` });
        const ai = (await res.json()) as ServerAi;
        this.setOffer({ ai, problem: ai.available ? null : "The server offers no language model: set KUBUS_AI_URL and KUBUS_AI_FIELD_MODEL there." });
      })
      .catch(() => target === this.offerFor && this.setOffer({ ai: null, problem: `Can't reach ${url}.` }));
  }

  /** Where `config` sends requests: the server's model through the server, or its own provider. */
  providerOf(config: AiConfig): AiProvider {
    if (config.source === "own") return config;
    const { ai } = this.offer_;
    const { url, token } = this.repo.sync.config;
    return ai?.available
      ? { baseUrl: `${url}/api/ai`, apiKey: token, fieldModel: ai.fieldModel, codeModel: ai.codeModel }
      : { baseUrl: "", apiKey: "", fieldModel: "", codeModel: "" };
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** The provider settings (replaced, never changed, so a hook can compare them). */
  get settings(): AiConfig {
    return this.current;
  }

  /** The model for a kind of work (the code model falls back to the field model). */
  modelFor(purpose: AiPurpose): string {
    const { fieldModel, codeModel } = this.providerOf(this.current);
    return (purpose === "code" ? codeModel.trim() || fieldModel : fieldModel).trim();
  }

  /** A model is chosen for this kind of work (and there is a provider): it can be asked. */
  isConfigured(purpose: AiPurpose): boolean {
    return this.modelFor(purpose) !== "" && this.providerOf(this.current).baseUrl.trim() !== "";
  }

  /** AI values can be generated. */
  get configured(): boolean {
    return this.isConfigured("field");
  }

  setSettings(settings: AiConfig) {
    this.current = settings;
    writePref(SETTINGS_KEY, settings);
    // What waited for a model runs now.
    if (this.configured) this.admit([...this.held.values()], false, true);
    // Resuming (or a new model) lets what waits go on.
    this.pump();
  }

  client(purpose: AiPurpose) {
    const { baseUrl, apiKey } = this.providerOf(this.current);
    return createLlmClient({ baseUrl, apiKey, model: this.modelFor(purpose) });
  }

  getProgress = () => this.progress;

  /** Whether this item's value was generated a moment ago (its change announcement is ours). */
  isRecent(itemId: string): boolean {
    return this.recent.has(itemId);
  }

  /** What a value is doing: "queued" | "running" | "held" | "error: …" | "" (nothing). Stable strings, for hooks. */
  cellState(itemId: string, fieldId: string): string {
    const key = keyOf(itemId, fieldId);
    if (this.running.has(key)) return "running";
    if (this.queued.has(key)) return "queued";
    // Waiting for a model, or in the backfill's line: an old value stays as it is until its turn.
    if (this.held.has(key) || this.backlog.has(key)) return "held";
    const failure = this.failed.get(key);
    if (failure) return `error: ${failure.message}`;
    const problem = this.problems.get(key);
    return problem ? `error: ${problem}` : "";
  }

  /** Records which values have no prompt to send, and why (null: it has one now). */
  setProblems(entries: Iterable<[itemId: string, fieldId: string, problem: string | null]>) {
    let changed = false;
    for (const [itemId, fieldId, problem] of entries) {
      const key = keyOf(itemId, fieldId);
      if (this.problems.get(key) === (problem ?? undefined)) continue;
      changed = true;
      if (problem) this.problems.set(key, problem);
      else this.problems.delete(key);
    }
    if (changed) this.notify();
  }

  /** Stale values found by something that shows items: they go first. */
  offer(jobs: AiJob[]) {
    if (jobs.length > 0) this.admit(jobs, false, false);
  }

  /** Stale values found by the backfill (not necessarily shown anywhere): they wait behind the shown ones. */
  offerBackground(jobs: AiJob[]) {
    if (jobs.length > 0) this.admit(jobs, true, false);
  }

  /** Records values the user just typed as right for the item as its prompt reads now. */
  adopt(jobs: AiJob[]) {
    for (const job of jobs) {
      const key = `${keyOf(job.itemId, job.field.id)}:${job.request.hash}`;
      if (this.adopting.has(key)) continue;
      this.adopting.add(key);
      this.repo.acceptEdit(job.collection, job.itemId, job.field, job.request.hash).catch((e) => console.error("Recording an edited AI value failed", e)).finally(() => this.adopting.delete(key));
    }
  }

  /**
   * Typed values whose prompt has changed: kept in the question (replaced when asked again), and
   * `settled` ones (nothing to ask about any more) taken out of it.
   */
  offerOverrides(jobs: AiJob[], settled: [itemId: string, fieldId: string][] = []) {
    let changed = false;
    for (const [itemId, fieldId] of settled) changed = this.overrides.delete(keyOf(itemId, fieldId)) || changed;
    for (const job of jobs) {
      const key = keyOf(job.itemId, job.field.id);
      if (this.overrides.get(key)?.request.hash === job.request.hash) continue;
      this.overrides.set(key, job);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The answer "generate again": the typed values are replaced by new ones. */
  replaceOverrides() {
    for (const [key, job] of this.overrides) this.queued.set(key, { ...job, force: true });
    this.overrides.clear();
    this.pump();
  }

  /** The answer "keep": the typed values stay, as right for their items as they are now (asked again only when that changes). */
  keepOverrides() {
    this.adopt([...this.overrides.values()]);
    this.overrides.clear();
    this.notify();
  }

  /** Generates a value again, whatever is stored. */
  regenerate(job: AiJob) {
    const key = keyOf(job.itemId, job.field.id);
    this.overrides.delete(key);
    this.failed.delete(key);
    this.held.delete(key);
    this.backlog.delete(key);
    this.queued.set(key, { ...job, force: true });
    this.pump();
  }

  /** The go-ahead for a long queue (asked by a modal). */
  confirmQueue() {
    this.approved = true;
    this.pump();
  }

  /** "Not now": drops what waits (it comes back after a restart, or when the item or prompt changes). */
  cancelQueue() {
    for (const [key, job] of [...this.queued, ...this.backlog]) this.dismissed.add(`${key}:${job.request.hash}`);
    this.queued.clear();
    this.backlog.clear();
    this.pump();
  }

  /** Drops what waits for a model (it comes back after a restart, or when the item or prompt changes). */
  dismissHeld() {
    for (const [key, job] of this.held) this.dismissed.add(`${key}:${job.request.hash}`);
    this.held.clear();
    this.notify();
  }

  /** Gives up on what failed (it comes back after a restart, or when the item or prompt changes). */
  dismissFailed() {
    for (const [key, { job }] of this.failed) this.dismissed.add(`${key}:${job.request.hash}`);
    this.failed.clear();
    this.notify();
  }

  retryFailed() {
    for (const [key, { job }] of this.failed) (job.background ? this.backlog : this.queued).set(key, { ...job, attempts: 0 });
    this.failed.clear();
    this.pump();
  }

  /** `release`: these are the held ones, looked at again (a model was set up). */
  private admit(jobs: AiJob[], background: boolean, release: boolean) {
    for (const job of jobs) {
      const key = keyOf(job.itemId, job.field.id);
      const hash = job.request.hash;
      if (this.dismissed.has(`${key}:${hash}`)) continue;
      if (this.failed.get(key)?.job.request.hash === hash) continue;
      if (this.running.get(key)?.request.hash === hash) continue;
      // Known already with this prompt: nothing new (a shown value moves up from the backfill's line, though).
      if (this.queued.get(key)?.request.hash === hash) continue;
      if (background && this.backlog.get(key)?.request.hash === hash) continue;
      if (!release && this.held.get(key)?.request.hash === hash) continue;
      this.failed.delete(key);
      this.held.delete(key);
      this.backlog.delete(key);
      this.queued.delete(key);
      if (!this.configured) this.held.set(key, job);
      else if (background) this.backlog.set(key, { ...job, background: true });
      else this.queued.set(key, job);
    }
    this.pump();
  }

  /** Starts what may start now: shown values before the backfill's, `CONCURRENCY` at a time, one per `MIN_INTERVAL_MS`. */
  private pump() {
    clearTimeout(this.timer);
    const waiting = this.queued.size + this.backlog.size;
    if (waiting + this.running.size === 0) this.approved = false;
    // Paused, or a long queue the user has not confirmed: nothing starts.
    const stopped = this.current.paused || (waiting > CONFIRM_LIMIT && !this.approved);
    while (!stopped && this.running.size < CONCURRENCY && (this.queued.size > 0 || this.backlog.size > 0)) {
      const wait = Math.max(this.pausedUntil, this.lastStart + MIN_INTERVAL_MS) - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => this.pump(), wait);
        break;
      }
      const from = this.queued.size > 0 ? this.queued : this.backlog;
      const [key, job] = from.entries().next().value!;
      from.delete(key);
      this.running.set(key, job);
      this.lastStart = Date.now();
      void this.run(key, job);
    }
    this.notify();
  }

  private async run(key: string, job: AiJob) {
    try {
      // Read again: another pane, or another device through sync, may have stored it meanwhile.
      const stored = await this.repo.getItem(job.collection, job.itemId);
      if (stored && (job.force || stored.aiInputs?.[job.field.id] !== job.request.hash)) {
        const prompt = job.hint ? `${job.request.prompt}\n\nA nudge from the user about this item: ${job.hint}` : job.request.prompt;
        const reply = await this.client("field").complete([
          { role: "system", content: job.request.system },
          { role: "user", content: prompt },
        ]);
        const parsed = parseAiReply(job.field.aiOutput ?? "string", reply);
        if ("error" in parsed) throw new Error(parsed.error);
        this.recent.add(job.itemId);
        setTimeout(() => this.recent.delete(job.itemId), RECENT_MS);
        await this.repo.setGenerated(job.collection, job.itemId, job.field, parsed.value, job.request.hash);
      }
    } catch (e) {
      const message = messageOf(e);
      if (isRateLimit(message) && (job.attempts ?? 0) < MAX_ATTEMPTS) {
        // Too many requests: everything waits a while, and this value is tried again.
        this.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
        (job.background ? this.backlog : this.queued).set(key, { ...job, attempts: (job.attempts ?? 0) + 1 });
      } else {
        this.failed.set(key, { job, message });
      }
    } finally {
      this.running.delete(key);
      this.pump();
    }
  }

  private measure(): AiProgress {
    const failures = [...this.failed.values()];
    const waiting = this.queued.size + this.backlog.size;
    const asked = [...this.overrides.values()][0];
    return {
      held: this.held.size,
      overrides: this.overrides.size,
      overrideSample: asked ? `${asked.label ?? ""} · ${asked.field.name}` : undefined,
      confirm: !this.current.paused && !this.approved && waiting > CONFIRM_LIMIT ? waiting : 0,
      paused: this.current.paused,
      working: this.queued.size + this.backlog.size + this.running.size,
      failed: failures.length,
      lastError: failures.at(-1)?.message,
      configured: this.configured,
    };
  }

  private notify() {
    const next = this.measure();
    const p = this.progress;
    // A new object only when something shows differently, so hooks re-render only then.
    if (next.held !== p.held || next.confirm !== p.confirm || next.overrides !== p.overrides || next.overrideSample !== p.overrideSample || next.paused !== p.paused || next.working !== p.working || next.failed !== p.failed || next.lastError !== p.lastError || next.configured !== p.configured) {
      this.progress = next;
    }
    for (const listener of this.listeners) listener();
  }
}
