import { createLogger, requestMeta } from "@fyrden/adapters-cloudflare/obs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { authRouter } from "./auth/login.js";
import { mountEmailEvents } from "./email/events.js";
import { mountUnsubscribe } from "./email/unsubscribe.js";
import { gitRouter } from "./git/router.js";
import { deepHealth } from "./health.js";
import { problem } from "./http/problem.js";
import { mountLive } from "./live/routes.js";
import { mountMcp } from "./mcp/mount.js";
import type { AuthVariables } from "./middleware/auth.js";
import { obs } from "./middleware/obs.js";
import { wellKnownRouter } from "./oauth/metadata.js";
import { oauthRouter } from "./oauth/token.js";
import { READ_MODEL_PROTOCOL } from "./read-model/executor.js";
import { mountArchives } from "./rest/archive.js";
import { mountRest } from "./rest/mount.js";
import { mountRaw } from "./rest/raw.js";
import { bootstrap } from "./routes/admin/bootstrap.js";

export type AppEnv = { Bindings: Env; Variables: AuthVariables };

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use(requestId());
  app.use(obs);

  // Unhandled errors go through the redacting logger, never Hono's default
  // console.error, and the client gets a generic problem document.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const log = c.get("log") ?? createLogger({ requestId: c.get("requestId") });
    log.error("unhandled error", { error: err });
    return problem(c, 500, "internal_error", "An unexpected error occurred.");
  });

  app.get("/healthz", async (c) => {
    const result = await deepHealth(c.env, requestMeta(c.get("log")), c.get("metrics"));
    // The version served needs no check: a deploy reads it here even when the checks are limited.
    if (result.rateLimited)
      return c.json(
        { ok: false, error: "rate_limited", readModel: { protocol: READ_MODEL_PROTOCOL } },
        429,
      );
    return c.json(
      { ...result.report, requestId: c.get("requestId") },
      result.report.ok ? 200 : 503,
    );
  });

  app.route("/v0/admin/bootstrap", bootstrap);
  app.route("/oauth", oauthRouter);
  mountEmailEvents(app);
  app.route("/auth", authRouter);
  app.route("/.well-known", wellKnownRouter);
  mountLive(app);
  mountRest(app);
  mountRaw(app);
  mountArchives(app);
  mountMcp(app);
  mountUnsubscribe(app);
  app.route("/", gitRouter);

  return app;
}
