import type { Hono } from "hono";
import type { ArchiveFormat } from "../do/repo/archive.js";
import { problem } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { API_PREFIX } from "./mount.js";
import { readAccess } from "./raw.js";

/** GitHub's archive routes and the format each serves. */
const ROUTES: readonly { route: string; format: ArchiveFormat; type: string; ext: string }[] = [
  { route: "tarball", format: "tar.gz", type: "application/gzip", ext: "tar.gz" },
  { route: "zipball", format: "zip", type: "application/zip", ext: "zip" },
];

/** How long a client should wait before asking again for an archive being built. */
const RETRY_AFTER_SECONDS = 5;

/**
 * `GET /api/repos/{owner}/{repo}/tarball[/{ref}]` and `/zipball[/{ref}]`:
 * a commit's files as `<owner>-<repo>-<short id>/...` (GitHub's tarball and
 * zipball), streamed from the segments the repository's object built; 202
 * with `Retry-After` while it is still building.
 */
export function mountArchives(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  for (const { route, format, type, ext } of ROUTES) {
    for (const path of [`${route}`, `${route}/:ref{.+}`]) {
      app.get(`${API_PREFIX}/repos/:owner/:repo/${path}`, requireAuth("by-method"), async (c) => {
        const access = await readAccess(c, "download archives");
        if (access instanceof Response) return access;
        const { ctx, repo, ref } = access;
        ctx.metrics.count("do.request", { class: "RepoDO", method: "archive" });
        const prefix = `${repo.ownerHandle}-${repo.name}`;
        const archive = await c.env.REPO.getByName(repo.id).archive({
          ...(ref !== undefined && { ref }),
          format,
          prefix,
        });
        if (!archive.ok) return problem(c, archive.status, archive.code, archive.error);
        const status = archive.value;
        if (status.state === "building")
          return c.json({ state: "building", commit: status.commit, bytes: status.bytes }, 202, {
            "Retry-After": String(RETRY_AFTER_SECONDS),
          });
        let next = 0;
        const bucket = c.env.GIT;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const key = status.keys[next++];
            if (key === undefined) {
              controller.close();
              return;
            }
            ctx.metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get_archive" });
            const object = await bucket.get(key);
            if (!object) {
              controller.error(new Error(`archive segment ${key} is missing`));
              return;
            }
            controller.enqueue(new Uint8Array(await object.arrayBuffer()));
          },
        });
        const filename = `${prefix}-${status.commit.slice(0, 7)}.${ext}`;
        return new Response(body, {
          headers: {
            "Content-Type": type,
            "Content-Length": String(status.bytes),
            "Content-Disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-cache",
            ETag: `"${status.commit}.${ext}"`,
          },
        });
      });
    }
  }
}
