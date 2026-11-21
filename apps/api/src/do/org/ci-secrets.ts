/*
 * An account's Actions secrets and variables, and the data keys its secrets
 * are sealed with (see `ci/envelope.ts` and docs/operations/ci-secrets.md).
 *
 * A secret arrives sealed for its scope's box key (as `gh secret set` seals
 * it); it is opened here and sealed again at once under the data key of the
 * generation it was sent for, so its value is never stored or answered as
 * plain text. Crypto is asynchronous and transactions are not, so a write is
 * prepared first (data key unwrapped, box opened, value sealed) and committed
 * in a transaction that checks nothing it depends on moved meanwhile:
 *
 * - a repository's CI epoch, read before preparing, refuses a write that
 *   spans the repository leaving, arriving or being deleted (409
 *   `repository_changed`, never retried here, since a repository that left
 *   and came back would pass any check read again);
 * - a data key's rewrap or a new generation commits only if the row (or
 *   the newest generation) is still the one it read, and is otherwise read
 *   again (at most `CAS_ATTEMPTS` times).
 */
import {
  ciName,
  ciValueBytes,
  MAX_CI_VALUE_BYTES,
  MAX_ORG_SECRETS,
  MAX_ORG_VARIABLES,
  MAX_REPO_SECRETS,
  MAX_REPO_VARIABLES,
  MAX_RUN_VARIABLES_BYTES,
  MAX_SELECTED_REPOS,
  type OrgVisibility,
  type RepoVisibility,
  runVariables,
} from "@fyrden/domain";
import {
  boxKey,
  type CiKeyring,
  ciSecretKeys,
  newDataKey,
  sealSecretValue,
  unwrapDataKey,
  type WrappedDataKey,
  wrapDataKey,
} from "../../ci/envelope.js";
import { openSealedBox } from "../../ci/sealed-box.js";
import { fromBase64 } from "../../crypto/bytes.js";

/** The scope of an organization's own secrets and variables; any other scope is a repository id. */
export const ORG_SCOPE = "org";

/** An organization entry as a repository's view lists it. */
export interface CiRepoViewItem {
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly value?: string;
  readonly unreadable?: true;
}

export type CiKind = "secret" | "variable";

export type CiFailure = {
  readonly ok: false;
  readonly status: 404 | 409 | 422 | 503;
  readonly code: string;
  readonly error: string;
};
export type CiResult<T> = { readonly ok: true; readonly value: T } | CiFailure;

export interface CiSecretItem {
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** An organization secret's. */
  readonly visibility?: OrgVisibility;
  /** Its generation's data key cannot be opened with the master keys this deployment holds. */
  readonly unreadable?: true;
}

export interface CiVariableItem {
  readonly name: string;
  readonly value: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly visibility?: OrgVisibility;
}

export interface CiPage<T> {
  readonly total: number;
  readonly items: T[];
}

export interface CiActor {
  readonly principalId: string;
  readonly requestId?: string;
}

/** What `AccountCi` needs of its account object. */
export interface CiHost {
  readonly storage: DurableObjectStorage;
  readonly env: Env;
  now(): number;
  account(): { readonly id: string; readonly kind: "org" | "user" } | undefined;
  /** Whether the repository is not the account's any more (deleted, or moved away). */
  notHere(repoId: string): boolean;
  /** In a transaction: the audit row of a change. */
  audit(actor: CiActor | null, action: string, details: Record<string, unknown>): void;
  /** After a transaction that wrote an audit row. */
  audited(): void;
  /** A test's pause point (see `accountHooks`). */
  pause(point: "listed" | "prepared" | "keyPrepared" | "rewrapPrepared"): Promise<void>;
}

/** How often a guarded data key change reads its row again after losing to another. */
const CAS_ATTEMPTS = 3;

const KINDS = {
  secret: {
    rows: "ci_secrets",
    repos: "ci_secret_repos",
    maxOrg: MAX_ORG_SECRETS,
    maxRepo: MAX_REPO_SECRETS,
    noun: "secret",
  },
  variable: {
    rows: "ci_variables",
    repos: "ci_variable_repos",
    maxOrg: MAX_ORG_VARIABLES,
    maxRepo: MAX_REPO_VARIABLES,
    noun: "variable",
  },
} as const;

type DataKeyRow = {
  generation: number;
  wrapped: string;
  nonce: string;
  master_key_id: string;
};

const fail = (status: CiFailure["status"], code: string, error: string): CiFailure => ({
  ok: false,
  status,
  code,
  error,
});
const ok = <T>(value: T): CiResult<T> => ({ ok: true, value });

const NOT_AN_ORG = fail(404, "not_an_org", "The account is not an organization.");
const REPO_GONE = fail(404, "repo_not_found", "The repository is not this account's any more.");
const REPO_CHANGED = fail(
  409,
  "repository_changed",
  "The repository moved or was deleted while the change was being made; send it again.",
);
const BAD_KEY_ID = fail(
  422,
  "bad_key_id",
  "key_id is not this scope's public key: get the public key again and seal the value for it.",
);
const UNDECRYPTABLE = fail(
  422,
  "undecryptable_value",
  "encrypted_value does not open: seal the value (UTF-8) for the scope's public key with a libsodium sealed box, in base64.",
);

const notFound = (kind: CiKind, name: string) =>
  fail(404, `${kind}_not_found`, `No ${kind} ${name} was found.`);
const invalidName = (kind: CiKind) =>
  fail(
    422,
    `invalid_${kind}_name`,
    `A ${kind} name has letters, digits and underscores, does not start with a digit or GITHUB_${kind === "secret" ? ", and is not GITEA_TOKEN" : ""}.`,
  );

/** A data key's place, for its additional data. */
const at = (accountId: string, generation: number) => ({ accountId, generation });
const wrappedOf = (row: DataKeyRow): WrappedDataKey => ({
  masterKeyId: row.master_key_id,
  nonce: row.nonce,
  wrapped: row.wrapped,
});

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const KEY_ID = /^([1-9][0-9]{0,8})\.[0-9a-f]{16}$/;

/**
 * The names of `rows` (in their order) while their running total of bytes
 * stays within `cap`, and that total: the first that does not fit ends it.
 */
function keptPrefix(
  rows: readonly { readonly name: string; readonly bytes: number }[],
  cap: number,
): { names: string[]; bytes: number } {
  const names: string[] = [];
  let bytes = 0;
  for (const r of rows) {
    if (bytes + r.bytes > cap) break;
    bytes += r.bytes;
    names.push(r.name);
  }
  return { names, bytes };
}

export class AccountCi {
  constructor(private readonly host: CiHost) {}

  get #sql() {
    return this.host.storage.sql;
  }

  #keys(): Promise<CiKeyring> {
    return ciSecretKeys(this.host.env);
  }

  // --- Data keys -------------------------------------------------------------

  #newest(): DataKeyRow | undefined {
    return this.#sql
      .exec<DataKeyRow>(
        "SELECT generation, wrapped, nonce, master_key_id FROM ci_data_keys ORDER BY generation DESC LIMIT 1",
      )
      .toArray()[0];
  }

  #generation(generation: number): DataKeyRow | undefined {
    return this.#sql
      .exec<DataKeyRow>(
        "SELECT generation, wrapped, nonce, master_key_id FROM ci_data_keys WHERE generation = ?",
        generation,
      )
      .toArray()[0];
  }

  #unavailable(keys: CiKeyring): CiFailure {
    return fail(
      503,
      "ci_key_unavailable",
      keys.misconfigured
        ? `${keys.misconfigured}: Actions secrets cannot be written until it is fixed.`
        : "The CI master key is not set: Actions secrets cannot be written.",
    );
  }

  /**
   * The public key of `scope`: the newest generation's. With no generation
   * yet, or when the newest one's master key is gone from a healthy keyring
   * (a lost key), a new generation is made first; of concurrent requests,
   * one makes it and the others serve it.
   */
  async publicKey(
    actor: CiActor,
    scope: string,
  ): Promise<CiResult<{ keyId: string; key: string }>> {
    const account = this.host.account();
    if (!account) return fail(404, "not_recorded", "The account has no records yet.");
    const refused = this.#scopeRefusal(account, scope);
    if (refused) return refused;
    const keys = await this.#keys();
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const newest = this.#newest();
      if (newest) {
        const dataKey = await unwrapDataKey(
          keys,
          at(account.id, newest.generation),
          wrappedOf(newest),
        );
        if (dataKey) {
          const box = await boxKey(dataKey, newest.generation, scope);
          return ok({ keyId: box.keyId, key: box.key });
        }
        // Its master key is held but does not open it: nothing to recover by a new generation.
        if (keys.byId.has(newest.master_key_id))
          return fail(503, "ci_key_unavailable", "The account's data key does not open.");
      }
      if (!keys.current) return this.#unavailable(keys);
      const generation = (newest?.generation ?? 0) + 1;
      const dataKey = newDataKey();
      const wrapped = await wrapDataKey(keys, at(account.id, generation), dataKey);
      if (!wrapped) return this.#unavailable(keys);
      await this.host.pause("keyPrepared");
      const made = this.host.storage.transactionSync(() => {
        if (this.#newest()?.generation !== newest?.generation) return false;
        const now = this.host.now();
        this.#sql.exec(
          `INSERT INTO ci_data_keys (generation, wrapped, nonce, master_key_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          generation,
          wrapped.wrapped,
          wrapped.nonce,
          wrapped.masterKeyId,
          now,
        );
        if (newest)
          this.#sql.exec(
            "UPDATE ci_data_keys SET lost_at = ? WHERE generation = ?",
            now,
            newest.generation,
          );
        this.host.audit(actor, "ci.data_key.create", {
          generation,
          ...(newest && { replaces: newest.generation }),
        });
        return true;
      });
      if (made) {
        this.host.audited();
        const box = await boxKey(dataKey, generation, scope);
        return ok({ keyId: box.keyId, key: box.key });
      }
    }
    return fail(503, "ci_key_unavailable", "The account's data key kept changing; try again.");
  }

  /**
   * Wraps again under the current master key every data key under another,
   * each guarded against a concurrent change of its row. `remaining`: those
   * still under another key that open; `unreadable`: those whose master key
   * is gone.
   */
  async rewrap(
    expectedKeyId?: string,
  ): Promise<{ rewrapped: number; remaining: number; unreadable: number }> {
    const account = this.host.account();
    if (!account) return { rewrapped: 0, remaining: 0, unreadable: 0 };
    const keys = await this.#keys();
    // An object still on a version with another current key (a deployment rolling out) wraps
    // nothing, and counts as remaining every data key not under the key the caller expects.
    if (expectedKeyId !== undefined && keys.current?.id !== expectedKeyId)
      return {
        rewrapped: 0,
        remaining: this.#sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM ci_data_keys WHERE master_key_id <> ?",
            expectedKeyId,
          )
          .one().n,
        unreadable: 0,
      };
    return this.#rewrap(account.id, keys);
  }

  async #rewrap(
    accountId: string,
    keys: CiKeyring,
  ): Promise<{ rewrapped: number; remaining: number; unreadable: number }> {
    const current = keys.current;
    const stale = () =>
      this.#sql
        .exec<DataKeyRow>(
          `SELECT generation, wrapped, nonce, master_key_id FROM ci_data_keys
           WHERE master_key_id <> ? ORDER BY generation`,
          current?.id ?? "",
        )
        .toArray();
    if (!current) return { rewrapped: 0, remaining: stale().length, unreadable: 0 };
    let rewrapped = 0;
    let unreadable = 0;
    for (const first of stale()) {
      let row: DataKeyRow | undefined = first;
      for (
        let attempt = 0;
        attempt < CAS_ATTEMPTS && row && row.master_key_id !== current.id;
        attempt++
      ) {
        const place = at(accountId, row.generation);
        const dataKey = await unwrapDataKey(keys, place, wrappedOf(row));
        if (!dataKey) {
          unreadable++;
          break;
        }
        const wrapped = await wrapDataKey(keys, place, dataKey);
        if (!wrapped) break;
        await this.host.pause("rewrapPrepared");
        const read = row;
        const done =
          this.#sql.exec(
            `UPDATE ci_data_keys SET wrapped = ?, nonce = ?, master_key_id = ?
             WHERE generation = ? AND wrapped = ? AND nonce = ? AND master_key_id = ?`,
            wrapped.wrapped,
            wrapped.nonce,
            wrapped.masterKeyId,
            read.generation,
            read.wrapped,
            read.nonce,
            read.master_key_id,
          ).rowsWritten > 0;
        if (done) {
          rewrapped++;
          break;
        }
        row = this.#generation(read.generation);
      }
    }
    return { rewrapped, remaining: stale().length - unreadable, unreadable };
  }

  /** Data keys by generation, unwrapped; a generation that does not open is absent. */
  async #dataKeys(
    accountId: string,
    generations: Iterable<number>,
  ): Promise<Map<number, Uint8Array>> {
    const keys = await this.#keys();
    const out = new Map<number, Uint8Array>();
    for (const generation of new Set(generations)) {
      const row = this.#generation(generation);
      const key = row && (await unwrapDataKey(keys, at(accountId, generation), wrappedOf(row)));
      if (key) out.set(generation, key);
    }
    return out;
  }

  // --- Secrets ---------------------------------------------------------------

  /**
   * Sets a secret from a value sealed for the scope's public key of
   * generation `keyId`: created (true) or updated (false).
   */
  async setSecret(input: {
    readonly actor: CiActor;
    readonly scope: string;
    readonly name: string;
    readonly keyId: string;
    readonly encryptedValue: string;
    readonly visibility?: OrgVisibility;
    readonly selectedRepoIds?: readonly string[];
  }): Promise<CiResult<{ created: boolean }>> {
    const account = this.host.account();
    if (!account) return fail(404, "not_recorded", "The account has no records yet.");
    const refused = this.#scopeRefusal(account, input.scope);
    if (refused) return refused;
    const name = ciName("secret", input.name);
    if (!name) return invalidName("secret");
    const selected = input.visibility === "selected" ? input.selectedRepoIds : undefined;
    const epochs = this.#epochs(input.scope, selected);
    const keys = await this.#keys();
    if (!keys.current) return this.#unavailable(keys);
    if (selected) {
      const unknown = await this.#unknownRepos(account.id, selected);
      if (unknown) return this.#movedSince(epochs) ?? unknown;
    }
    const generation = Number(KEY_ID.exec(input.keyId)?.[1] ?? Number.NaN);
    const row = Number.isSafeInteger(generation) ? this.#generation(generation) : undefined;
    if (!row) return BAD_KEY_ID;
    const dataKey = await unwrapDataKey(keys, at(account.id, generation), wrappedOf(row));
    if (!dataKey) return BAD_KEY_ID;
    const box = await boxKey(dataKey, generation, input.scope);
    if (box.keyId !== input.keyId) return BAD_KEY_ID;
    const sealed = fromBase64(input.encryptedValue);
    const plain = sealed && (await openSealedBox(box, sealed));
    if (!plain) return UNDECRYPTABLE;
    let value: string;
    try {
      if (plain.length > MAX_CI_VALUE_BYTES)
        return fail(
          422,
          "secret_too_large",
          `A secret's value is ${MAX_CI_VALUE_BYTES} bytes at most.`,
        );
      value = strictUtf8.decode(plain);
    } catch {
      return UNDECRYPTABLE;
    } finally {
      plain.fill(0);
    }
    // Sealed under the data key at once, so the plain value lives only until here.
    const stored = await sealSecretValue(
      dataKey,
      { accountId: account.id, scope: input.scope, name, generation },
      value,
    );
    // A write is a moment to move the account's data keys onto the current master key.
    await this.#rewrap(account.id, keys);
    await this.host.pause("prepared");
    const answer = this.host.storage.transactionSync((): CiResult<{ created: boolean }> => {
      const moved = this.#fenceFailure(epochs);
      if (moved) return moved;
      const exists = this.#exists("secret", input.scope, name);
      if (!exists) {
        const full = this.#full("secret", input.scope);
        if (full) return full;
      }
      const now = this.host.now();
      this.#sql.exec(
        `INSERT INTO ci_secrets (scope, name, generation, nonce, ciphertext, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, name) DO UPDATE SET generation = excluded.generation,
           nonce = excluded.nonce, ciphertext = excluded.ciphertext,
           visibility = excluded.visibility, updated_at = excluded.updated_at`,
        input.scope,
        name,
        generation,
        stored.nonce,
        stored.ciphertext,
        input.scope === ORG_SCOPE ? (input.visibility ?? "private") : null,
        now,
        now,
      );
      if (input.scope === ORG_SCOPE) this.#keepRepos("secret", name, input.visibility, selected);
      this.host.audit(input.actor, exists ? "ci.secret.update" : "ci.secret.create", {
        scope: input.scope,
        name,
        ...(input.visibility && { visibility: input.visibility }),
        generation,
      });
      return ok({ created: !exists });
    });
    if (answer.ok) this.host.audited();
    return answer;
  }

  /** A page of the scope's secrets by name, without values. */
  async secrets(
    scope: string,
    page: number,
    perPage: number,
  ): Promise<CiResult<CiPage<CiSecretItem>>> {
    const account = this.host.account();
    if (!account) return ok({ total: 0, items: [] });
    const refused = this.#scopeRefusal(account, scope);
    if (refused) return refused;
    const total = this.#count("secret", scope);
    const rows = this.#sql
      .exec<SecretRow>(
        `SELECT name, generation, visibility, created_at, updated_at FROM ci_secrets
         WHERE scope = ? ORDER BY name LIMIT ? OFFSET ?`,
        scope,
        perPage,
        (page - 1) * perPage,
      )
      .toArray();
    return ok({ total, items: await this.#secretItems(account.id, rows) });
  }

  async secret(scope: string, name: string): Promise<CiResult<CiSecretItem>> {
    const account = this.host.account();
    const stored = ciName("secret", name);
    if (!account || !stored) return notFound("secret", name);
    const refused = this.#scopeRefusal(account, scope);
    if (refused) return refused;
    const row = this.#sql
      .exec<SecretRow>(
        `SELECT name, generation, visibility, created_at, updated_at FROM ci_secrets
         WHERE scope = ? AND name = ?`,
        scope,
        stored,
      )
      .toArray()[0];
    if (!row) return notFound("secret", stored);
    const [item] = await this.#secretItems(account.id, [row]);
    return ok(item as CiSecretItem);
  }

  async #secretItems(accountId: string, rows: readonly SecretRow[]): Promise<CiSecretItem[]> {
    const open = await this.#dataKeys(
      accountId,
      rows.map((r) => r.generation),
    );
    return rows.map((r) => ({
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.visibility && { visibility: r.visibility }),
      ...(!open.has(r.generation) && { unreadable: true as const }),
    }));
  }

  /**
   * The organization secrets or variables that reach a repository of
   * `visibility`, by name: every one, not only the 100 secrets a run takes.
   */
  async repoView(
    kind: CiKind,
    repoId: string,
    visibility: RepoVisibility,
    page: number,
    perPage: number,
  ): Promise<CiResult<CiPage<CiRepoViewItem>>> {
    const account = this.host.account();
    // A repository this account let go (or forgot) reads none of its entries.
    if (this.host.notHere(repoId)) return REPO_GONE;
    if (account?.kind !== "org") return ok({ total: 0, items: [] });
    const t = KINDS[kind];
    // `reachesRepo` in SQL, so only the page's rows (and values) are read.
    const reaches = `e.scope = 'org' AND (e.visibility = 'all'
      OR (e.visibility = 'private' AND ?1 <> 'public')
      OR (e.visibility = 'selected'
        AND EXISTS (SELECT 1 FROM ${t.repos} r WHERE r.name = e.name AND r.repo_id = ?2)))`;
    const total = this.#sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM ${t.rows} e WHERE ${reaches}`,
        visibility,
        repoId,
      )
      .one().n;
    const rows = this.#sql
      .exec<{
        name: string;
        value: string | null;
        generation: number | null;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT e.name,
           ${kind === "variable" ? "e.value AS value, NULL AS generation" : "NULL AS value, e.generation AS generation"},
           e.created_at, e.updated_at
         FROM ${t.rows} e WHERE ${reaches} ORDER BY e.name LIMIT ?3 OFFSET ?4`,
        visibility,
        repoId,
        perPage,
        (page - 1) * perPage,
      )
      .toArray();
    // As the organization's own list marks them: a secret of a generation that does not open.
    const open =
      kind === "secret"
        ? await this.#dataKeys(
            account.id,
            rows.flatMap((r) => (r.generation === null ? [] : [r.generation])),
          )
        : undefined;
    return ok({
      total,
      items: rows.map((r) => ({
        name: r.name,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        ...(r.value !== null && { value: r.value }),
        ...(open &&
          r.generation !== null &&
          !open.has(r.generation) && { unreadable: true as const }),
      })),
    });
  }

  /** Deletes a secret or a variable. */
  remove(actor: CiActor, kind: CiKind, scope: string, name: string): CiResult<null> {
    const account = this.host.account();
    const stored = ciName(kind, name);
    if (!account || !stored) return notFound(kind, name);
    const refused = this.#scopeRefusal(account, scope);
    if (refused) return refused;
    const t = KINDS[kind];
    const answer = this.host.storage.transactionSync((): CiResult<null> => {
      const gone = this.#sql.exec(
        `DELETE FROM ${t.rows} WHERE scope = ? AND name = ?`,
        scope,
        stored,
      ).rowsWritten;
      if (gone === 0) return notFound(kind, stored);
      if (scope === ORG_SCOPE) this.#sql.exec(`DELETE FROM ${t.repos} WHERE name = ?`, stored);
      this.host.audit(actor, `ci.${kind}.delete`, { scope, name: stored });
      return ok(null);
    });
    if (answer.ok) this.host.audited();
    return answer;
  }

  // --- Variables -------------------------------------------------------------

  /** Creates a variable; 409 `variable_exists` when the scope has one of the name. */
  async createVariable(input: {
    readonly actor: CiActor;
    readonly scope: string;
    readonly name: string;
    readonly value: string;
    readonly visibility?: OrgVisibility;
    readonly selectedRepoIds?: readonly string[];
  }): Promise<CiResult<null>> {
    const account = this.host.account();
    if (!account) return fail(404, "not_recorded", "The account has no records yet.");
    const refused = this.#scopeRefusal(account, input.scope);
    if (refused) return refused;
    const name = ciName("variable", input.name);
    if (!name) return invalidName("variable");
    const tooLarge = this.#variableTooLarge(input.value);
    if (tooLarge) return tooLarge;
    const selected = input.visibility === "selected" ? input.selectedRepoIds : undefined;
    const epochs = this.#epochs(input.scope, selected);
    if (selected) {
      const unknown = await this.#unknownRepos(account.id, selected);
      if (unknown) return this.#movedSince(epochs) ?? unknown;
    }
    await this.host.pause("prepared");
    const answer = this.host.storage.transactionSync((): CiResult<null> => {
      const moved = this.#fenceFailure(epochs);
      if (moved) return moved;
      if (this.#exists("variable", input.scope, name))
        return fail(409, "variable_exists", `The variable ${name} exists already.`);
      const full = this.#full("variable", input.scope);
      if (full) return full;
      const now = this.host.now();
      this.#sql.exec(
        `INSERT INTO ci_variables (scope, name, value, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.scope,
        name,
        input.value,
        input.scope === ORG_SCOPE ? (input.visibility ?? "private") : null,
        now,
        now,
      );
      if (input.scope === ORG_SCOPE) this.#keepRepos("variable", name, input.visibility, selected);
      this.host.audit(input.actor, "ci.variable.create", {
        scope: input.scope,
        name,
        ...(input.visibility && { visibility: input.visibility }),
      });
      return ok(null);
    });
    if (answer.ok) this.host.audited();
    return answer;
  }

  /** Changes a variable's value or visibility. */
  async updateVariable(input: {
    readonly actor: CiActor;
    readonly scope: string;
    readonly name: string;
    readonly value?: string;
    readonly visibility?: OrgVisibility;
    readonly selectedRepoIds?: readonly string[];
  }): Promise<CiResult<null>> {
    const account = this.host.account();
    const name = ciName("variable", input.name);
    if (!account || !name) return notFound("variable", input.name);
    const refused = this.#scopeRefusal(account, input.scope);
    if (refused) return refused;
    if (input.value !== undefined) {
      const tooLarge = this.#variableTooLarge(input.value);
      if (tooLarge) return tooLarge;
    }
    // A list alone replaces a selected variable's list (GitHub takes one only for `selected`).
    const listOnly =
      input.scope === ORG_SCOPE &&
      input.visibility === undefined &&
      input.selectedRepoIds !== undefined;
    if (listOnly) {
      const entry = this.#orgEntry("variable", name);
      if (!entry.ok) return entry;
    }
    const visibility = listOnly ? "selected" : input.visibility;
    const selected = visibility === "selected" ? input.selectedRepoIds : undefined;
    const epochs = this.#epochs(input.scope, selected);
    if (selected) {
      const unknown = await this.#unknownRepos(account.id, selected);
      if (unknown) return this.#movedSince(epochs) ?? unknown;
    }
    await this.host.pause("prepared");
    const answer = this.host.storage.transactionSync((): CiResult<null> => {
      const moved = this.#fenceFailure(epochs);
      if (moved) return moved;
      if (!this.#exists("variable", input.scope, name)) return notFound("variable", name);
      if (listOnly) {
        // Still selected: another request may have changed its visibility meanwhile.
        const entry = this.#orgEntry("variable", name);
        if (!entry.ok) return entry;
      }
      this.#sql.exec(
        `UPDATE ci_variables SET value = coalesce(?, value),
           visibility = coalesce(?, visibility), updated_at = ?
         WHERE scope = ? AND name = ?`,
        input.value ?? null,
        input.scope === ORG_SCOPE ? (visibility ?? null) : null,
        this.host.now(),
        input.scope,
        name,
      );
      if (input.scope === ORG_SCOPE && visibility !== undefined)
        this.#keepRepos("variable", name, visibility, selected);
      this.host.audit(input.actor, "ci.variable.update", {
        scope: input.scope,
        name,
        ...(input.visibility && { visibility: input.visibility }),
        ...(listOnly && selected && { repos: [...new Set(selected)] }),
      });
      return ok(null);
    });
    if (answer.ok) this.host.audited();
    return answer;
  }

  variables(scope: string, page: number, perPage: number): CiResult<CiPage<CiVariableItem>> {
    const account = this.host.account();
    if (!account) return ok({ total: 0, items: [] });
    const refused = this.#scopeRefusal(account, scope);
    if (refused) return refused;
    const rows = this.#sql
      .exec<VariableRow>(
        `SELECT name, value, visibility, created_at, updated_at FROM ci_variables
         WHERE scope = ? ORDER BY name LIMIT ? OFFSET ?`,
        scope,
        perPage,
        (page - 1) * perPage,
      )
      .toArray();
    return ok({ total: this.#count("variable", scope), items: rows.map(variableItem) });
  }

  variable(scope: string, name: string): CiResult<CiVariableItem> {
    const account = this.host.account();
    const stored = ciName("variable", name);
    if (!account || !stored) return notFound("variable", name);
    const refused = this.#scopeRefusal(account, scope);
    if (refused) return refused;
    const row = this.#sql
      .exec<VariableRow>(
        `SELECT name, value, visibility, created_at, updated_at FROM ci_variables
         WHERE scope = ? AND name = ?`,
        scope,
        stored,
      )
      .toArray()[0];
    return row ? ok(variableItem(row)) : notFound("variable", stored);
  }

  /**
   * The variables a run of repository `repoId` gets now, by name: its own
   * over the organization's that reach it (by the repository's visibility in
   * the directory now), within `MAX_RUN_VARIABLES_BYTES` as `runVariables`
   * takes them. The kept prefix is chosen from names and sizes alone
   * (`octet_length` of a column reads no content: verified,
   * https://www.sqlite.org/lang_corefunc.html#octet_length), and only the
   * kept values are read. Refused for a repository the account does not hold.
   */
  async variablesFor(repoId: string): Promise<CiResult<Record<string, string>>> {
    if (this.host.notHere(repoId)) return REPO_GONE;
    const account = this.host.account();
    // An account never recorded holds no variables.
    if (!account) return ok({});
    const row = await this.host.env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT visibility FROM repos WHERE id = ? AND owner_id = ? AND state = 'active'")
      .bind(repoId, account.id)
      .first<{ visibility: RepoVisibility }>();
    if (!row || this.host.notHere(repoId)) return REPO_GONE;
    // No await from here: the sizes and the values are of the same rows.
    const sized = "e.name, octet_length(e.name) + octet_length(e.value) AS bytes";
    const ownNames = keptPrefix(
      this.#sql
        .exec<{ name: string; bytes: number }>(
          `SELECT ${sized} FROM ci_variables e WHERE e.scope = ? ORDER BY e.name`,
          repoId,
        )
        .toArray(),
      MAX_RUN_VARIABLES_BYTES,
    );
    const own = ownNames.names.length
      ? this.#sql
          .exec<{ name: string; value: string }>(
            "SELECT name, value FROM ci_variables WHERE scope = ? AND name <= ? ORDER BY name",
            repoId,
            ownNames.names.at(-1) as string,
          )
          .toArray()
      : [];
    const orgNames =
      account.kind === "org"
        ? keptPrefix(
            this.#sql
              .exec<{ name: string; bytes: number }>(
                `SELECT ${sized} FROM ci_variables e
                 WHERE e.scope = 'org' AND (e.visibility = 'all'
                   OR (e.visibility = 'private' AND ?1 <> 'public')
                   OR (e.visibility = 'selected' AND EXISTS (
                     SELECT 1 FROM ci_variable_repos r WHERE r.name = e.name AND r.repo_id = ?2)))
                   AND NOT EXISTS (
                     SELECT 1 FROM ci_variables o WHERE o.scope = ?2 AND o.name = e.name)
                 ORDER BY e.name`,
                row.visibility,
                repoId,
              )
              .toArray(),
            MAX_RUN_VARIABLES_BYTES - ownNames.bytes,
          ).names
        : [];
    const org = orgNames.length
      ? this.#sql
          .exec<{ name: string; value: string }>(
            // Looked up by key, one name at a time: no other organization row is read.
            `SELECT name, value FROM ci_variables
             WHERE scope = 'org' AND name IN (SELECT value FROM json_each(?)) ORDER BY name`,
            JSON.stringify(orgNames),
          )
          .toArray()
      : [];
    // The rows read already reach the repository; `runVariables` keeps the rule's last word.
    return ok(
      runVariables(
        org.map((v) => ({ name: v.name, value: v.value, visibility: "all", selected: false })),
        own,
        row.visibility,
      ),
    );
  }

  // --- An organization entry's selected repositories --------------------------

  /**
   * Every repository id an organization secret or variable of visibility
   * `selected` lists (the directory pages them, keeping only the
   * organization's own).
   */
  selectedRepos(kind: CiKind, name: string): CiResult<string[]> {
    const found = this.#orgEntry(kind, name);
    if (!found.ok) return found;
    return ok(
      this.#sql
        .exec<{ repo_id: string }>(
          `SELECT repo_id FROM ${KINDS[kind].repos} WHERE name = ? ORDER BY repo_id`,
          found.value,
        )
        .toArray()
        .map((r) => r.repo_id),
    );
  }

  /**
   * Changes the list of an organization entry of visibility `selected`:
   * replaced (`set`), or one repository added or removed.
   */
  async changeSelected(
    actor: CiActor,
    kind: CiKind,
    name: string,
    change:
      | { readonly set: readonly string[] }
      | { readonly add: string }
      | { readonly remove: string },
  ): Promise<CiResult<null>> {
    const account = this.host.account();
    const first = this.#orgEntry(kind, name);
    if (!account || !first.ok) return first.ok ? NOT_AN_ORG : first;
    const stored = first.value;
    const adding = "set" in change ? change.set : "add" in change ? [change.add] : undefined;
    const epochs = this.#epochs(ORG_SCOPE, adding);
    if (adding) {
      const unknown = await this.#unknownRepos(account.id, adding);
      if (unknown) return this.#movedSince(epochs) ?? unknown;
    }
    await this.host.pause("prepared");
    const t = KINDS[kind];
    const answer = this.host.storage.transactionSync((): CiResult<null> => {
      const found = this.#orgEntry(kind, stored);
      if (!found.ok) return found;
      const moved = this.#fenceFailure(epochs);
      if (moved) return moved;
      if ("set" in change) {
        this.#sql.exec(`DELETE FROM ${t.repos} WHERE name = ?`, stored);
        for (const id of new Set(change.set))
          this.#sql.exec(`INSERT INTO ${t.repos} (name, repo_id) VALUES (?, ?)`, stored, id);
      } else if ("add" in change) {
        const listed =
          this.#sql
            .exec(`SELECT 1 FROM ${t.repos} WHERE name = ? AND repo_id = ?`, stored, change.add)
            .toArray().length > 0;
        const count = this.#sql
          .exec<{ n: number }>(`SELECT count(*) AS n FROM ${t.repos} WHERE name = ?`, stored)
          .one().n;
        if (!listed && count >= MAX_SELECTED_REPOS)
          return fail(
            422,
            "too_many_repositories",
            `An organization ${kind} lists ${MAX_SELECTED_REPOS} repositories at most.`,
          );
        this.#sql.exec(
          `INSERT INTO ${t.repos} (name, repo_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
          stored,
          change.add,
        );
      } else
        this.#sql.exec(
          `DELETE FROM ${t.repos} WHERE name = ? AND repo_id = ?`,
          stored,
          change.remove,
        );
      const [action, details] =
        "set" in change
          ? ["repos.set", { repos: [...new Set(change.set)] }]
          : "add" in change
            ? ["repo.add", { repo: change.add }]
            : ["repo.remove", { repo: change.remove }];
      this.host.audit(actor, `ci.${kind}.${action}`, {
        scope: ORG_SCOPE,
        name: stored,
        ...details,
      });
      return ok(null);
    });
    if (answer.ok) this.host.audited();
    return answer;
  }

  /** The stored name of organization entry `name`, if it exists and its visibility is `selected`. */
  #orgEntry(kind: CiKind, name: string): CiResult<string> {
    const account = this.host.account();
    if (account?.kind !== "org") return NOT_AN_ORG;
    const stored = ciName(kind, name);
    if (!stored) return notFound(kind, name);
    const row = this.#sql
      .exec<{ visibility: OrgVisibility }>(
        `SELECT visibility FROM ${KINDS[kind].rows} WHERE scope = 'org' AND name = ?`,
        stored,
      )
      .toArray()[0];
    if (!row) return notFound(kind, stored);
    if (row.visibility !== "selected")
      return fail(
        409,
        "visibility_not_selected",
        `The ${kind} ${stored} reaches ${row.visibility === "all" ? "every repository" : "private repositories"}, not a list: set its visibility to selected first.`,
      );
    return ok(stored);
  }

  // --- Repositories leaving --------------------------------------------------

  /**
   * In a transaction: repository `repoId` left the account (moved away or
   * deleted). Its secrets and variables go, it leaves every list, and its
   * CI epoch moves, so a write prepared before is refused.
   */
  forgetRepo(repoId: string): void {
    for (const t of Object.values(KINDS)) {
      this.#sql.exec(`DELETE FROM ${t.rows} WHERE scope = ?`, repoId);
      this.#sql.exec(`DELETE FROM ${t.repos} WHERE repo_id = ?`, repoId);
    }
    this.bumpEpoch(repoId);
  }

  /** In a transaction: moves repository `repoId`'s CI epoch (it arrived). */
  bumpEpoch(repoId: string): void {
    this.#sql.exec(
      `INSERT INTO ci_repo_epochs (repo_id, epoch) VALUES (?, 1)
       ON CONFLICT (repo_id) DO UPDATE SET epoch = epoch + 1`,
      repoId,
    );
  }

  // --- Shared checks ---------------------------------------------------------

  #scopeRefusal(account: { readonly kind: "org" | "user" }, scope: string): CiFailure | undefined {
    if (scope === ORG_SCOPE) return account.kind === "org" ? undefined : NOT_AN_ORG;
    return this.host.notHere(scope) ? REPO_GONE : undefined;
  }

  /** The CI epochs a write depends on: its repository's (a repository scope) and those it lists. */
  #epochs(scope: string, listed: readonly string[] | undefined): Fence {
    const read = (id: string) =>
      this.#sql
        .exec<{ epoch: number }>("SELECT epoch FROM ci_repo_epochs WHERE repo_id = ?", id)
        .toArray()[0]?.epoch ?? 0;
    return {
      scope: scope === ORG_SCOPE ? undefined : { id: scope, epoch: read(scope) },
      listed: [...new Set(listed ?? [])].map((id) => ({ id, epoch: read(id) })),
      read,
    };
  }

  /**
   * 409 when a repository the write depends on moved since its epochs were
   * read: one that left during the directory lookup is a change, not an
   * unknown id.
   */
  #movedSince(fence: Fence): CiFailure | undefined {
    const moved = [...(fence.scope ? [fence.scope] : []), ...fence.listed].some(
      (r) => fence.read(r.id) !== r.epoch,
    );
    return moved ? REPO_CHANGED : undefined;
  }

  /** In the commit's transaction: why the write may not land (a repository moved or went). */
  #fenceFailure(fence: Fence): CiFailure | undefined {
    if (fence.scope) {
      if (this.host.notHere(fence.scope.id)) return REPO_GONE;
      if (fence.read(fence.scope.id) !== fence.scope.epoch) return REPO_CHANGED;
    }
    for (const r of fence.listed)
      if (this.host.notHere(r.id) || fence.read(r.id) !== r.epoch) return REPO_CHANGED;
    return undefined;
  }

  /** Why `ids` may not be listed: one is not an active repository of the account in the directory. */
  async #unknownRepos(accountId: string, ids: readonly string[]): Promise<CiFailure | undefined> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return undefined;
    const { results } = await this.host.env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT id FROM repos
         WHERE id IN (SELECT value FROM json_each(?)) AND owner_id = ? AND state = 'active'`,
      )
      .bind(JSON.stringify(unique), accountId)
      .all<{ id: string }>();
    await this.host.pause("listed");
    const found = new Set(results.map((r) => r.id));
    const missing = unique.find((id) => !found.has(id) || this.host.notHere(id));
    return missing === undefined ? undefined : unknownRepository(missing);
  }

  #exists(kind: CiKind, scope: string, name: string): boolean {
    return (
      this.#sql
        .exec(`SELECT 1 FROM ${KINDS[kind].rows} WHERE scope = ? AND name = ?`, scope, name)
        .toArray().length > 0
    );
  }

  #count(kind: CiKind, scope: string): number {
    return this.#sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM ${KINDS[kind].rows} WHERE scope = ?`, scope)
      .one().n;
  }

  /** Why the scope takes no more entries of `kind`. */
  #full(kind: CiKind, scope: string): CiFailure | undefined {
    const t = KINDS[kind];
    const max = scope === ORG_SCOPE ? t.maxOrg : t.maxRepo;
    if (this.#count(kind, scope) < max) return undefined;
    return fail(
      422,
      `too_many_${kind}s`,
      `${scope === ORG_SCOPE ? "An organization" : "A repository"} has ${max} ${kind}s at most.`,
    );
  }

  #variableTooLarge(value: string): CiFailure | undefined {
    return ciValueBytes(value) > MAX_CI_VALUE_BYTES
      ? fail(
          422,
          "variable_too_large",
          `A variable's value is ${MAX_CI_VALUE_BYTES} bytes at most.`,
        )
      : undefined;
  }

  /**
   * In a transaction: an organization entry's list after a write that set
   * its visibility: replaced by `listed` when given, emptied unless the
   * visibility is `selected`, otherwise kept.
   */
  #keepRepos(
    kind: CiKind,
    name: string,
    visibility: OrgVisibility | undefined,
    listed: readonly string[] | undefined,
  ): void {
    const t = KINDS[kind];
    if (visibility !== "selected" || listed !== undefined)
      this.#sql.exec(`DELETE FROM ${t.repos} WHERE name = ?`, name);
    for (const id of new Set(listed ?? []))
      this.#sql.exec(`INSERT INTO ${t.repos} (name, repo_id) VALUES (?, ?)`, name, id);
  }
}

type Fence = {
  readonly scope: { readonly id: string; readonly epoch: number } | undefined;
  readonly listed: readonly { readonly id: string; readonly epoch: number }[];
  readonly read: (id: string) => number;
};

type SecretRow = {
  name: string;
  generation: number;
  visibility: OrgVisibility | null;
  created_at: number;
  updated_at: number;
};

type VariableRow = {
  name: string;
  value: string;
  visibility: OrgVisibility | null;
  created_at: number;
  updated_at: number;
};

const variableItem = (r: VariableRow): CiVariableItem => ({
  name: r.name,
  value: r.value,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.visibility && { visibility: r.visibility }),
});

const unknownRepository = (id: string) =>
  fail(422, "unknown_repository", `${id} is not a repository of this account.`);
