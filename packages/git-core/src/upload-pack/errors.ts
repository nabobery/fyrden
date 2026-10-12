import { type Oid, oidToHex } from "../object/oid.js";

/**
 * Why a fetch request was refused. The message is what the client sees,
 * in git's own wording where git has one (git v2.53.0 upload-pack.c), so
 * the transport can send it as an `ERR` packet unchanged.
 */
export type UploadPackErrorCode =
  /** A want is not reachable from this repository's current refs, or does not exist. */
  | "not-our-ref"
  /** A `shallow` line names an object that is not a commit. */
  | "invalid-shallow"
  /** A `deepen-not` name matches no ref, or more than one. */
  | "ambiguous-deepen-not"
  /** `deepen-since` or `deepen-not` leaves no commit to send. */
  | "no-shallow-commits"
  /** The request needs more commits or objects than this server walks for one fetch. */
  | "too-large";

export class UploadPackError extends Error {
  override readonly name = "UploadPackError";
  constructor(
    readonly code: UploadPackErrorCode,
    message: string,
    /** The object the error is about, when there is one. */
    readonly oid?: Oid,
  ) {
    super(message);
  }
}

export function notOurRef(oid: Oid): UploadPackError {
  return new UploadPackError("not-our-ref", `upload-pack: not our ref ${oidToHex(oid)}`, oid);
}
