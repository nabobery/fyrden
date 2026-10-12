import { readFileSync } from "node:fs";
import type { ProtocolErrorCode } from "../../src/protocol/errors.js";
import { bin, concat, pkt } from "./helpers.js";
import type { Target, TargetLimits } from "./targets.js";

/** One input part: bytes (one per character), a pkt-line (repeated), or a repeated string. */
type Part = string | { pkt: string; count?: number } | { repeat: string; count: number };

export interface ViolationCase {
  name: string;
  target: Target;
  input: Part[];
  code: ProtocolErrorCode;
  /** The git service that refuses the input too; absent where Fyrden is stricter or the limit is its own. */
  git?: "upload-pack" | "receive-pack";
  limits?: TargetLimits;
  source?: string;
}

/** The protocol-violation corpus, `test/corpus/protocol-violations/cases.json`. */
export const CORPUS: ViolationCase[] = JSON.parse(
  readFileSync(new URL("../corpus/protocol-violations/cases.json", import.meta.url), "utf8"),
).cases;

export function caseBytes(c: ViolationCase): Uint8Array {
  return concat(
    ...c.input.map((part) => {
      if (typeof part === "string") return bin(part);
      if ("pkt" in part) return bin(pkt(part.pkt).repeat(part.count ?? 1));
      return bin(part.repeat.repeat(part.count));
    }),
  );
}
