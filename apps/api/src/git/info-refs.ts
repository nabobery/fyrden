import { encodePktLine, encodeV2CapabilityAdvertisement, flushPkt } from "@fyrden/git-core";
import { authorizeGit } from "./auth.js";
import { type GitContext, gitPayload, gitText, repoParams } from "./http.js";
import {
  concatBytes,
  contentType,
  errPacket,
  isGitService,
  requestedProtocolVersion,
  UPLOAD_PACK_V2_CAPABILITIES,
  V2_ONLY_MESSAGE,
} from "./protocol.js";

/**
 * `GET <repo>/info/refs?service=...`, the smart HTTP discovery request
 * (gitprotocol-http, "Smart Clients"):
 *
 * - upload-pack: the protocol v2 capability advertisement, without the
 *   `# service=` preamble, as `git http-backend` sends for v2. A v0 or v1
 *   request gets an `ERR` packet naming protocol v2, which git prints as
 *   "remote error: ...". That check needs no authentication.
 * - receive-pack: `# service=git-receive-pack`, a flush, then the v0 ref
 *   advertisement (v1 with its version line when asked; protocol v2 has no
 *   push, so a v2 request also gets v0, as git does).
 *
 * Requests without `service` are dumb HTTP, which Fyrden does not serve.
 */
export async function infoRefs(c: GitContext): Promise<Response> {
  const service = c.req.query("service");
  if (service === undefined)
    return gitText(c, 403, "Fyrden supports only git's smart HTTP protocol.");
  if (!isGitService(service)) return gitText(c, 403, "Unsupported git service.");
  const advertisement = contentType.advertisement(service);
  const version = requestedProtocolVersion(c.req.header("Git-Protocol"));
  if (service === "git-upload-pack" && version !== 2) {
    return gitPayload(errPacket(V2_ONLY_MESSAGE), advertisement);
  }

  const { owner, name } = repoParams(c);
  const access = await authorizeGit(
    c,
    owner,
    name,
    service === "git-receive-pack" ? "write" : "read",
  );
  if (!access.ok) return access.response;

  if (service === "git-upload-pack") {
    return gitPayload(encodeV2CapabilityAdvertisement(UPLOAD_PACK_V2_CAPABILITIES), advertisement);
  }
  c.get("metrics").count("do.request", { class: "RepoDO", method: "receivePackAdvertisement" });
  const refs = await c.env.REPO.getByName(access.repo.id).receivePackAdvertisement(
    version === 1 ? 1 : 0,
  );
  return gitPayload(
    concatBytes([encodePktLine(`# service=${service}\n`), flushPkt(), refs]),
    advertisement,
  );
}
