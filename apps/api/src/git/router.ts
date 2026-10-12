import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.js";
import { uploadPart } from "./chunked/parts-route.js";
import { infoRefs } from "./info-refs.js";
import { receivePack } from "./receive-pack.js";
import { uploadPack } from "./upload-pack.js";

/**
 * git's smart HTTP protocol (gitprotocol-http) at `/<owner>/<repo>.git/...`;
 * the `.git` suffix is optional, as on GitHub.
 */
export const gitRouter = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
  .get("/:owner/:repo/info/refs", infoRefs)
  .post("/:owner/:repo/git-upload-pack", uploadPack)
  .post("/:owner/:repo/git-receive-pack", receivePack)
  // A chunked upload's parts (the session is the `uploads.*` operations).
  .put("/:owner/:repo/uploads/:upload_id/parts/:part", uploadPart);
