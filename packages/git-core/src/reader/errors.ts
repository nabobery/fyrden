import { type Oid, oidToHex } from "../object/oid.js";

/** Objects a walk was asked for that no pack in the reader's view holds. */
export class MissingObjectError extends Error {
  override readonly name = "MissingObjectError";
  readonly oids: readonly Oid[];

  constructor(oids: readonly Oid[]) {
    const shown = oids.slice(0, 3).map(oidToHex).join(", ");
    super(
      `missing object${oids.length === 1 ? "" : "s"} ${shown}${oids.length > 3 ? ", ..." : ""}`,
    );
    this.oids = oids;
  }
}

/** A reader built more bytes than its `maxBuiltBytes` allow, or its work port refused a charge. */
export class ReaderWorkSpent extends Error {
  override name = "ReaderWorkSpent";
  constructor(
    readonly limit: number,
    message = `building the objects read took more than ${limit} bytes`,
  ) {
    super(message);
  }
}
