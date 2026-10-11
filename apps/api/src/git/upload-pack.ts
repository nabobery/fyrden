import {
  DEFAULT_PKT_LINE_LIMITS,
  type LsRefsArgs,
  PktLineReader,
  ProtocolError,
  parseLsRefsArgs,
  readV2CommandRequest,
  type V2CommandRequest,
} from "@fyrden/git-core";
import type { RepoEntry } from "../repos/directory.js";
import { authorizeGit } from "./auth.js";
import { readRequestBody } from "./body.js";
import { fetchCommand } from "./fetch/command.js";
import {
  checkRequestType,
  type GitContext,
  gitError,
  gitPayload,
  gitText,
  repoParams,
} from "./http.js";
import {
  contentType,
  requestedProtocolVersion,
  UPLOAD_PACK_V2_ADVERTISED,
  V2_ONLY_MESSAGE,
} from "./protocol.js";

const SERVICE = "git-upload-pack";

/** One protocol v2 command: the request as parsed, for an authorized repository. */
export type UploadPackCommand = (
  c: GitContext,
  repo: RepoEntry,
  request: V2CommandRequest,
) => Promise<Response>;

const lsRefs: UploadPackCommand = async (c, repo, request) => {
  const args: LsRefsArgs = parseLsRefsArgs(request.args);
  c.get("metrics").count("do.request", { class: "RepoDO", method: "lsRefs" });
  const body = await c.env.REPO.getByName(repo.id).lsRefs(args);
  return gitPayload(body as Uint8Array<ArrayBuffer>, contentType.result(SERVICE));
};

const fetchPack: UploadPackCommand = (c, repo, request) => fetchCommand(c, repo, request.args);

/** Every advertised command has a handler here. */
export const UPLOAD_PACK_COMMANDS: Readonly<Record<string, UploadPackCommand>> = {
  "ls-refs": lsRefs,
  fetch: fetchPack,
};

/**
 * `POST <repo>/git-upload-pack`: one protocol v2 command request per POST
 * (stateless). Requests in any other protocol version are refused with the
 * protocol-v2 error. A malformed request gets an `ERR` packet with git's
 * own wording for the fault (status 200, so git shows it; see `gitError`).
 */
export async function uploadPack(c: GitContext): Promise<Response> {
  const wrongType = checkRequestType(c, SERVICE);
  if (wrongType) return wrongType;
  if (requestedProtocolVersion(c.req.header("Git-Protocol")) !== 2)
    return gitError(SERVICE, V2_ONLY_MESSAGE);

  const { owner, name } = repoParams(c);
  const access = await authorizeGit(c, owner, name, "read");
  if (!access.ok) return access.response;

  const body = await readRequestBody(c.req.raw, DEFAULT_PKT_LINE_LIMITS.maxBytes);
  if (!body.ok) return gitText(c, body.status, body.message);

  let request: V2CommandRequest | undefined;
  try {
    request = await readV2CommandRequest(new PktLineReader(body.bytes), UPLOAD_PACK_V2_ADVERTISED);
  } catch (error) {
    if (error instanceof ProtocolError) return gitError(SERVICE, error.message);
    throw error;
  }
  // A lone flush ends the session: nothing to answer.
  if (request === undefined) return gitPayload(new Uint8Array(0), contentType.result(SERVICE));

  const command = UPLOAD_PACK_COMMANDS[request.command];
  if (!command) return gitError(SERVICE, `invalid command '${request.command}'`);
  try {
    return await command(c, access.repo, request);
  } catch (error) {
    if (error instanceof ProtocolError) return gitError(SERVICE, error.message);
    throw error;
  }
}
