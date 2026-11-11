import { apiFetch, assertSameOrigin, readJson } from "../lib/api.server.js";
import { repoApiPath } from "../lib/pulls.js";
import type { Route } from "./+types/repo.release-uploads";

/**
 * `POST /:owner/:repo/releases/uploads`: an asset upload's session, begun, completed or ended
 * for the browser's uploader (`lib/asset-upload.ts`) through the binding, the API's answer
 * passed back as it came. JSON in and out, so the page's script reads it as it reads the
 * parts route. Only named fields go on, so nothing else reaches the API's paths or bodies.
 */

/** A completion of 2,000 parts is about 150 KB of JSON. */
const UPLOAD_JSON_MAX_BYTES = 512 * 1024;
const UPLOAD_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** A completion's key, made by the browser: a UUID, as `crypto.randomUUID` makes. */
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refused = (detail: string, status = 400) =>
  Response.json(
    { code: "invalid_input", detail },
    { status, headers: { "Cache-Control": "no-store" } },
  );

/** The API's answer, as it came: status, JSON body and when to ask again. */
function passed(res: Response): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["Content-Type", "Retry-After"]) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const body = await readJson(request, UPLOAD_JSON_MAX_BYTES);
  if (typeof body !== "object" || body === null) return refused("Send a JSON object.");
  const sent = body as Record<string, unknown>;
  const base = repoApiPath(params.owner, params.repo);
  switch (sent.intent) {
    case "begin": {
      const { release_id, name, size, content_type, replace } = sent;
      if (!Number.isSafeInteger(release_id) || (release_id as number) < 1)
        return refused("No such release.");
      if (typeof name !== "string" || !Number.isSafeInteger(size) || typeof replace !== "boolean")
        return refused("Give the file's name, size and whether it replaces one.");
      if (content_type !== undefined && typeof content_type !== "string")
        return refused("A content type is text.");
      return passed(
        await apiFetch(
          context,
          request,
          "POST",
          `${base}/releases/${release_id}/assets/uploads`,
          JSON.stringify({
            name,
            size,
            replace,
            ...(content_type !== undefined && { content_type }),
          }),
        ),
      );
    }
    case "complete": {
      const { upload_id, parts, key } = sent;
      if (typeof upload_id !== "string" || !UPLOAD_ID.test(upload_id))
        return refused("No such upload.");
      if (!Array.isArray(parts)) return refused("Give the parts' etags.");
      if (typeof key !== "string" || !KEY.test(key)) return refused("The key must be a UUID.");
      return passed(
        await apiFetch(
          context,
          request,
          "POST",
          `${base}/releases/assets/uploads/${upload_id}/complete`,
          JSON.stringify({ parts }),
          key,
        ),
      );
    }
    case "abort": {
      const { upload_id } = sent;
      if (typeof upload_id !== "string" || !UPLOAD_ID.test(upload_id))
        return refused("No such upload.");
      return passed(
        await apiFetch(context, request, "DELETE", `${base}/releases/assets/uploads/${upload_id}`),
      );
    }
    default:
      return refused("Begin, complete or abort.");
  }
}
