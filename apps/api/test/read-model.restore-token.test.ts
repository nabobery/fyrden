// The read model's restore token (`POST /admin/read-model/handshake`): a
// handshake replaces the token the read model holds and the directory
// records, in three steps (the directory's intent, the read model's write,
// the directory's completion), one interrupted finished by the next from
// what the read model holds; a read model holding a token the directory
// does not know (restored to before the last handshake) is refused, and the
// status says so.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import { handshake, handshakeHooks, restoreTokenState } from "../src/read-model/restore-token.js";
import { api, json, user } from "./helpers/api.js";

const db = readModelFor(env, DEFAULT_ORG_SHARD);

const tokens = () =>
  env.DIRECTORY.prepare(
    `SELECT token_previous AS previous, token_next AS next, token_completed AS completed
     FROM read_model_barriers WHERE shard = ?`,
  )
    .bind(DEFAULT_ORG_SHARD)
    .first<{ previous: string | null; next: string | null; completed: string | null }>();

const held = async () =>
  (
    await db.prepare("SELECT token FROM read_model_restore_token WHERE id = 1").first<{
      token: string;
    }>()
  )?.token ?? null;

/** The read model's token set to `token` (none, when null), as a restore would leave it. */
async function holding(token: string | null): Promise<void> {
  await (token === null
    ? db.prepare("DELETE FROM read_model_restore_token").run()
    : db
        .prepare(
          `INSERT INTO read_model_restore_token (id, token) VALUES (1, ?1)
           ON CONFLICT (id) DO UPDATE SET token = ?1`,
        )
        .bind(token)
        .run());
}

const call = (token: string) =>
  json<{ restore_token?: string; code?: string }>(
    api("POST", "/admin/read-model/handshake", token, {}),
  );

const status = async (token: string) =>
  (await json<{ protocol: { restore_token: string } }>(api("GET", "/admin/search/status", token)))
    .body.protocol.restore_token;

// Each test from none written, its hooks its own.
beforeEach(async () => {
  await env.DIRECTORY.prepare(
    `UPDATE read_model_barriers SET token_previous = NULL, token_next = NULL,
       token_completed = NULL WHERE shard = ?`,
  )
    .bind(DEFAULT_ORG_SHARD)
    .run();
  await holding(null);
});
afterEach(() => {
  delete handshakeHooks.afterIntent;
  delete handshakeHooks.afterWrite;
});

describe("the read model's restore token", () => {
  it("starts with the first handshake, and is replaced by each one after", async () => {
    const admin = await user(true);
    expect(await status(admin.token)).toBe("uninitialized");
    const first = await call(admin.token);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ restore_token: "matched" });
    const after = await tokens();
    expect(after).toEqual({ previous: null, next: null, completed: await held() });
    expect(after?.completed).not.toBeNull();
    expect(await status(admin.token)).toBe("matched");
    expect((await call(admin.token)).status).toBe(200);
    const again = await tokens();
    expect(again?.completed).not.toBe(after?.completed);
    expect(again?.completed).toBe(await held());
  });

  it("is told apart when the read model holds an older one (restored), and refused", async () => {
    const admin = await user(true);
    expect((await call(admin.token)).status).toBe(200);
    const old = await held();
    expect((await call(admin.token)).status).toBe(200);
    const known = await tokens();
    // Restored to before the last handshake: the token it held then.
    await holding(old);
    expect(await status(admin.token)).toBe("mismatch");
    const refused = await call(admin.token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("restore_token_mismatch");
    expect(await tokens()).toEqual(known);
    expect(await held()).toBe(old);
  });

  it("is told apart when the read model holds one where none was ever written", async () => {
    await holding("restored-from-elsewhere");
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("mismatch");
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("mismatch");
    expect(await tokens()).toEqual({ previous: null, next: null, completed: null });
  });

  it("is finished by the next handshake when one stops after its intent", async () => {
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    const before = await held();
    handshakeHooks.afterIntent = async () => {
      throw new Error("stopped after its intent");
    };
    await expect(handshake(env, DEFAULT_ORG_SHARD)).rejects.toThrow(/after its intent/);
    const intent = await tokens();
    expect(intent).toMatchObject({ previous: before, completed: before });
    expect(intent?.next).not.toBeNull();
    expect(await held()).toBe(before);
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("intent");
    delete handshakeHooks.afterIntent;
    // Finished with the intent's token, not a new one.
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    expect(await tokens()).toEqual({ previous: null, next: null, completed: intent?.next });
    expect(await held()).toBe(intent?.next);
  });

  it("writes nothing over a token restored between its intent and its write", async () => {
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    handshakeHooks.afterIntent = () => holding("restored-meanwhile");
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("mismatch");
    expect(await held()).toBe("restored-meanwhile");
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("mismatch");
  });

  it("is finished by the next handshake when one stops after the read model's write", async () => {
    handshakeHooks.afterWrite = async () => {
      throw new Error("stopped after its write");
    };
    await expect(handshake(env, DEFAULT_ORG_SHARD)).rejects.toThrow(/after its write/);
    const intent = await tokens();
    expect(await held()).toBe(intent?.next);
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("intent");
    delete handshakeHooks.afterWrite;
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    expect(await tokens()).toEqual({ previous: null, next: null, completed: intent?.next });
  });

  it("is not taken for a restore when a handshake completes between a look's two reads", async () => {
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    handshakeHooks.betweenReads = async () => {
      delete handshakeHooks.betweenReads;
      expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    };
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("matched");
  });

  it("settles when another handshake finishes its intent meanwhile", async () => {
    handshakeHooks.afterIntent = async () => {
      delete handshakeHooks.afterIntent;
      // Another call finds the intent and finishes it.
      expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    };
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
    const after = await tokens();
    expect(after).toMatchObject({ previous: null, next: null });
    expect(after?.completed).toBe(await held());
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("matched");
  });

  it("is replaced while the writers are paused, by a maintenance writer", async () => {
    let paused = await pauseReadModel(env, DEFAULT_ORG_SHARD);
    for (let step = 0; step < 5 && paused.phase !== "paused"; step++)
      paused = await pauseReadModel(env, DEFAULT_ORG_SHARD);
    expect(paused.phase).toBe("paused");
    try {
      expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("matched");
      expect(await held()).toBe((await tokens())?.completed);
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
  });

  it("is replaced only by instance administrators", async () => {
    const someone = await user();
    expect((await call(someone.token)).status).toBe(403);
    expect(await tokens()).toEqual({ previous: null, next: null, completed: null });
  });
});
