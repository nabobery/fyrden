import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  newSecret,
  openSecret,
  type SealedSecret,
  type SecretKeys,
  sealSecret,
} from "../../webhooks/secrets.js";
import { type Browsed, fail } from "./browse.js";
import type { RepoEvents } from "./events.js";

/*
 * The repository's webhooks. Each names a URL, the events it takes, and
 * whether it is on; every change bumps its configuration version, which
 * each event routed to it records. Its signing secret is made here, shown
 * once, and kept sealed (see `webhooks/secrets.ts`); while a secret is
 * being replaced, the new one and the previous one both sign, until the
 * previous one is dropped or a week has passed.
 *
 * Events reach hooks through `RepoEvents`: each event an active hook takes
 * carries the hook's id and configuration version, written with the event.
 */

/** The events a hook may take (GitHub's names); `ping` goes to the hook it is for. */
export const HOOK_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Limits of a repository's webhooks. Proposed. */
export const HOOK_POLICY = {
  maxHooks: 20,
  /** How long a replaced secret still signs, unless dropped sooner. */
  previousSecretMs: 7 * 24 * 60 * 60_000,
} as const;

/** The repository events each hook event is made from. */
const EVENT_OF: Readonly<Record<string, HookEvent | "ping">> = {
  "refs.updated": "push",
  "webhook.ping": "ping",
};

/** A hook as the API shows it (never its secrets). */
export interface HookView {
  readonly id: number;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly configVersion: number;
  readonly disabledReason: string | null;
  /** How many secrets sign its deliveries (two while one is replaced). */
  readonly secrets: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a delivery attempt needs of its hook, read when the attempt is made. */
export type HookForDelivery =
  | {
      readonly kind: "hook";
      readonly url: string;
      readonly active: boolean;
      readonly configVersion: number;
      /** The host it was set on: with `FYRDEN_OWN_HOSTS`, the hosts it must not reach. */
      readonly apiHost: string;
      readonly private: boolean;
      /** Its signing secrets, open, newest first; none when the key that sealed them is gone. */
      readonly secrets: readonly string[];
    }
  /** The hook, or the repository, is gone. */
  | { readonly kind: "gone" };

type Row = {
  hook_id: number;
  url: string;
  events: string;
  active: number;
  config_version: number;
  secrets: string;
  api_host: string;
  disabled_reason: string | null;
  created_at: number;
  updated_at: number;
};

/** A new secret and its sealed form, for the hook `id`. */
export interface PreparedSecret {
  readonly id: number;
  readonly secret: string;
  readonly sealed: SealedSecret;
}

/** A secret kept, and until when a replaced one still signs. */
type Kept = SealedSecret & { readonly until?: number };

export interface HooksDeps {
  readonly git: RepoGitStorage;
  readonly events: RepoEvents;
  readonly repoId: () => string;
  readonly keys: () => Promise<SecretKeys>;
}

const NO_KEY = fail(
  422,
  "webhooks_unavailable",
  "The server has no key to keep webhook secrets with (WEBHOOKS_KEY).",
);
const notFound = (id: number) =>
  fail(404, "hook_not_found", `The repository has no webhook ${id}.`);

export class RepoHooks {
  constructor(private readonly deps: HooksDeps) {
    deps.events.routeHooks((type, data) => this.#route(type, data));
  }

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  list(): HookView[] {
    return this.#sql
      .exec<Row>("SELECT * FROM webhooks ORDER BY hook_id")
      .toArray()
      .map((row) => view(row, this.deps.git.context.now()));
  }

  get(id: number): HookView | undefined {
    const row = this.#row(id);
    return row && view(row, this.deps.git.context.now());
  }

  /**
   * A new secret, sealed for hook `id` (a new hook's id taken now when
   * absent): made before the change that stores it, which then has no wait.
   */
  async prepareSecret(id?: number): Promise<Browsed<PreparedSecret>> {
    const { git } = this.deps;
    const hookId =
      id ??
      git.context.storage.transactionSync(
        () =>
          this.#sql
            .exec<{ last: number }>(
              `INSERT INTO webhook_ids (id, last)
               VALUES (1, coalesce((SELECT max(hook_id) FROM webhooks), 0) + 1)
               ON CONFLICT (id) DO UPDATE SET last = last + 1 RETURNING last`,
            )
            .one().last,
      );
    const secret = newSecret();
    const sealed = await sealSecret(
      await this.deps.keys(),
      { repoId: this.deps.repoId(), hookId },
      secret,
      git.context.now(),
    );
    return sealed ? { ok: true, value: { id: hookId, secret, sealed } } : NO_KEY;
  }

  /** Adds a hook with its prepared secret, and sends it a `ping`. Answers the hook and its secret. */
  create(
    prepared: PreparedSecret,
    input: {
      readonly url: string;
      readonly events: readonly HookEvent[];
      readonly active: boolean;
      readonly apiHost: string;
    },
    actor: RefActor,
  ): Browsed<{ hook: HookView; secret: string }> {
    const { git } = this.deps;
    const now = git.context.now();
    return git.context.storage.transactionSync(() => {
      const count = this.#sql.exec<{ n: number }>("SELECT count(*) AS n FROM webhooks").one().n;
      if (count >= HOOK_POLICY.maxHooks)
        return fail(
          422,
          "too_many_hooks",
          `A repository has ${HOOK_POLICY.maxHooks} webhooks at most.`,
        );
      this.#sql.exec(
        `INSERT INTO webhooks (hook_id, url, events, active, config_version, secrets, api_host,
           disabled_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)`,
        prepared.id,
        input.url,
        JSON.stringify([...new Set(input.events)].sort()),
        input.active ? 1 : 0,
        JSON.stringify([prepared.sealed]),
        input.apiHost,
        now,
        now,
      );
      this.deps.events.auditChange("hook.create", actor, { hook: prepared.id, url: input.url });
      if (input.active)
        this.deps.events.emitActivity("webhook.ping", actor, { hook_id: prepared.id });
      return {
        ok: true as const,
        value: { hook: view(this.#row(prepared.id) as Row, now), secret: prepared.secret },
      };
    });
  }

  /** Changes a hook's URL, events or state; a hook turned on again loses its disabled reason. */
  update(
    id: number,
    patch: {
      readonly url?: string;
      readonly events?: readonly HookEvent[];
      /** Events added to, and removed from, the hook's (or `events`), in the change's transaction. */
      readonly addEvents?: readonly HookEvent[];
      readonly removeEvents?: readonly HookEvent[];
      readonly active?: boolean;
      readonly apiHost: string;
    },
    actor: RefActor,
  ): Browsed<HookView> {
    return this.deps.git.context.storage.transactionSync(() => {
      const row = this.#row(id);
      if (!row) return notFound(id);
      const active = patch.active ?? row.active === 1;
      const events = new Set<string>(patch.events ?? (JSON.parse(row.events) as string[]));
      for (const e of patch.addEvents ?? []) events.add(e);
      for (const e of patch.removeEvents ?? []) events.delete(e);
      if (events.size === 0)
        return fail(422, "invalid_input", "A webhook takes at least one event.");
      // `*` stands for every event alone.
      const subscribed = events.has("*") ? ["*"] : [...events].sort();
      this.#sql.exec(
        `UPDATE webhooks SET url = ?, events = ?, active = ?, config_version = config_version + 1,
           api_host = ?, disabled_reason = ?, updated_at = ?
         WHERE hook_id = ?`,
        patch.url ?? row.url,
        JSON.stringify(subscribed),
        active ? 1 : 0,
        patch.url !== undefined ? patch.apiHost : row.api_host,
        active && row.active === 0 ? null : row.disabled_reason,
        this.deps.git.context.now(),
        id,
      );
      this.deps.events.auditChange("hook.update", actor, {
        hook: id,
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.events && { events: patch.events }),
        ...(patch.active !== undefined && { active: patch.active }),
      });
      return { ok: true as const, value: view(this.#row(id) as Row, this.deps.git.context.now()) };
    });
  }

  delete(id: number, actor: RefActor): Browsed<true> {
    return this.deps.git.context.storage.transactionSync(() => {
      const gone = this.#sql.exec("DELETE FROM webhooks WHERE hook_id = ?", id).rowsWritten;
      if (gone === 0) return notFound(id);
      this.deps.events.auditChange("hook.delete", actor, { hook: id });
      return { ok: true as const, value: true as const };
    });
  }

  /** Sends the hook a `ping` (an event of its own). */
  ping(id: number, actor: RefActor): Browsed<true> {
    return this.deps.git.context.storage.transactionSync(() => {
      const row = this.#row(id);
      if (!row) return notFound(id);
      if (row.active === 0)
        return fail(422, "hook_inactive", `Webhook ${id} is off; turn it on to ping it.`);
      this.deps.events.emitActivity("webhook.ping", actor, { hook_id: id });
      return { ok: true as const, value: true as const };
    });
  }

  /**
   * Gives the hook its prepared new secret (shown this once); the previous
   * one still signs for a week, or until dropped.
   */
  rotateSecret(prepared: PreparedSecret, actor: RefActor): Browsed<{ secret: string }> {
    const { git } = this.deps;
    const id = prepared.id;
    const now = git.context.now();
    return git.context.storage.transactionSync(() => {
      const row = this.#row(id);
      if (!row) return notFound(id);
      const [current] = kept(row, now);
      const secrets: Kept[] = [
        prepared.sealed,
        ...(current ? [{ ...current, until: now + HOOK_POLICY.previousSecretMs }] : []),
      ];
      this.#sql.exec(
        `UPDATE webhooks SET secrets = ?, config_version = config_version + 1, updated_at = ?
         WHERE hook_id = ?`,
        JSON.stringify(secrets),
        now,
        id,
      );
      this.deps.events.auditChange("hook.secret_rotate", actor, { hook: id });
      return { ok: true as const, value: { secret: prepared.secret } };
    });
  }

  /** Drops the previous secret now: only the newest signs. */
  dropPreviousSecret(id: number, actor: RefActor): Browsed<true> {
    const now = this.deps.git.context.now();
    return this.deps.git.context.storage.transactionSync(() => {
      const row = this.#row(id);
      if (!row) return notFound(id);
      const [current] = kept(row, now);
      this.#sql.exec(
        `UPDATE webhooks SET secrets = ?, config_version = config_version + 1, updated_at = ?
         WHERE hook_id = ?`,
        JSON.stringify(current ? [current] : []),
        now,
        id,
      );
      this.deps.events.auditChange("hook.secret_drop_previous", actor, { hook: id });
      return { ok: true as const, value: true as const };
    });
  }

  /**
   * What an attempt to deliver to the hook needs, now: its configuration
   * and open secrets. A secret sealed with a retired key is sealed again
   * with the current one.
   */
  async forDelivery(id: number, repoPrivate: boolean): Promise<HookForDelivery> {
    const row = this.#row(id);
    if (!row) return { kind: "gone" };
    const keys = await this.deps.keys();
    const at = { repoId: this.deps.repoId(), hookId: id };
    const now = this.deps.git.context.now();
    const secrets: string[] = [];
    let resealed = false;
    const stored: Kept[] = [];
    for (const secret of kept(row, now)) {
      const open = await openSecret(keys, at, secret);
      if (open === undefined) {
        stored.push(secret);
        continue;
      }
      secrets.push(open);
      if (keys.current && secret.keyId !== keys.current.id) {
        const again = await sealSecret(keys, at, open, secret.createdAt);
        if (again) {
          stored.push({ ...again, ...(secret.until !== undefined && { until: secret.until }) });
          resealed = true;
          continue;
        }
      }
      stored.push(secret);
    }
    // Sealed again (or rid of a replaced secret past its week) only if the hook's secrets are
    // still those read.
    if (resealed || stored.length < (JSON.parse(row.secrets) as Kept[]).length)
      this.#sql.exec(
        "UPDATE webhooks SET secrets = ? WHERE hook_id = ? AND secrets = ?",
        JSON.stringify(stored),
        id,
        row.secrets,
      );
    return {
      kind: "hook",
      url: row.url,
      active: row.active === 1,
      configVersion: row.config_version,
      apiHost: row.api_host,
      private: repoPrivate,
      secrets,
    };
  }

  /** Turns the hook off (its receiver answered 410 Gone), unless it changed since `version`. */
  disable(id: number, version: number, reason: string): boolean {
    return (
      this.#sql.exec(
        `UPDATE webhooks SET active = 0, disabled_reason = ?, config_version = config_version + 1,
           updated_at = ?
         WHERE hook_id = ? AND config_version = ? AND active = 1`,
        reason,
        this.deps.git.context.now(),
        id,
        version,
      ).rowsWritten > 0
    );
  }

  /**
   * Seals again, with the current key, up to `limit` secrets sealed with a
   * retired one; answers how many were, and how many are left that cannot
   * be opened (their key is gone).
   */
  async reseal(
    limit: number,
  ): Promise<{ resealed: number; remaining: number; unreadable: number }> {
    const keys = await this.deps.keys();
    let resealed = 0;
    let remaining = 0;
    let unreadable = 0;
    if (!keys.current) throw new Error("WEBHOOKS_KEY is not set: nothing can be sealed again");
    for (const row of this.#sql.exec<Row>("SELECT * FROM webhooks").toArray()) {
      const at = { repoId: this.deps.repoId(), hookId: row.hook_id };
      // A replaced secret past its week is dropped, not sealed again (nor counted unreadable).
      const secrets = kept(row, this.deps.git.context.now());
      const expired = secrets.length < (JSON.parse(row.secrets) as Kept[]).length;
      if (secrets.every((s) => s.keyId === keys.current?.id)) {
        if (expired)
          this.#sql.exec(
            "UPDATE webhooks SET secrets = ? WHERE hook_id = ? AND secrets = ?",
            JSON.stringify(secrets),
            row.hook_id,
            row.secrets,
          );
        continue;
      }
      if (resealed >= limit) {
        remaining++;
        continue;
      }
      const stored: Kept[] = [];
      for (const secret of secrets) {
        if (secret.keyId === keys.current.id) {
          stored.push(secret);
          continue;
        }
        const open = await openSecret(keys, at, secret);
        const again =
          open === undefined ? undefined : await sealSecret(keys, at, open, secret.createdAt);
        if (!again) {
          unreadable++;
          stored.push(secret);
          continue;
        }
        stored.push({ ...again, ...(secret.until !== undefined && { until: secret.until }) });
      }
      const written = this.#sql.exec(
        "UPDATE webhooks SET secrets = ? WHERE hook_id = ? AND secrets = ?",
        JSON.stringify(stored),
        row.hook_id,
        row.secrets,
      ).rowsWritten;
      // Changed meanwhile (rotated, dropped): looked at again on the next pass.
      if (written > 0) resealed++;
      else remaining++;
    }
    return { resealed, remaining, unreadable };
  }

  /** The active hooks an event of `type` goes to (a ping, only to its hook). */
  #route(type: string, data: Record<string, unknown> | null) {
    const event = EVENT_OF[type];
    if (!event) return [];
    if (event === "ping") {
      const row = this.#row(Number(data?.hook_id));
      return row?.active === 1 ? [{ id: row.hook_id, v: row.config_version }] : [];
    }
    return this.#sql
      .exec<Pick<Row, "hook_id" | "config_version" | "events">>(
        "SELECT hook_id, config_version, events FROM webhooks WHERE active = 1 ORDER BY hook_id",
      )
      .toArray()
      .filter((row) => {
        const events = JSON.parse(row.events) as string[];
        return events.includes(event) || events.includes("*");
      })
      .map((row) => ({ id: row.hook_id, v: row.config_version }));
  }

  #row(id: number): Row | undefined {
    if (!Number.isSafeInteger(id)) return undefined;
    return this.#sql.exec<Row>("SELECT * FROM webhooks WHERE hook_id = ?", id).toArray()[0];
  }
}

/** The hook's secrets that still sign at `now`, newest first. */
function kept(row: Row, now: number): Kept[] {
  return (JSON.parse(row.secrets) as Kept[]).filter((s) => s.until === undefined || s.until > now);
}

function view(row: Row, now: number): HookView {
  return {
    id: row.hook_id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    active: row.active === 1,
    configVersion: row.config_version,
    disabledReason: row.disabled_reason,
    secrets: kept(row, now).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
