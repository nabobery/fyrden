// A read model restored to before its restore token's table existed (org
// migration 0025): its token is told apart as a restore once the directory
// knows one, and nothing is written; none known, none was ever written.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { handshake, restoreTokenState } from "../src/read-model/restore-token.js";
import { api, json, user } from "./helpers/api.js";

describe("a read model without its restore token's table", () => {
  it("is uninitialized while the directory knows no token, and a restore once it knows one", async () => {
    // As a restore to before the migration leaves it (this file's database alone).
    await env.ORG_READ.exec("DROP TABLE read_model_restore_token");
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("uninitialized");
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET token_completed = 'known' WHERE shard = ?",
    )
      .bind(DEFAULT_ORG_SHARD)
      .run();
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("mismatch");
    expect(await handshake(env, DEFAULT_ORG_SHARD)).toBe("mismatch");
    const admin = await user(true);
    const refused = await json<{ code?: string }>(
      api("POST", "/admin/read-model/handshake", admin.token, {}),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("restore_token_mismatch");
    const status = await json<{ protocol: { restore_token: string } }>(
      api("GET", "/admin/search/status", admin.token),
    );
    expect(status.body.protocol.restore_token).toBe("mismatch");
  });
});
