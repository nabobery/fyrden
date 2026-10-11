import { type Oid, oidToHex } from "../object/oid.js";
import type { RefSnapshot } from "../ports/ref-store.js";
import { UploadPackError } from "./errors.js";
import type { RefTips } from "./wants.js";

/** git's `ref_rev_parse_rules` (refs.c, git v2.53.0), in order. */
const RULES = [
  (n: string) => n,
  (n: string) => `refs/${n}`,
  (n: string) => `refs/tags/${n}`,
  (n: string) => `refs/heads/${n}`,
  (n: string) => `refs/remotes/${n}`,
  (n: string) => `refs/remotes/${n}/HEAD`,
];

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function ambiguous(name: Uint8Array): UploadPackError {
  let shown: string;
  try {
    shown = utf8.decode(name);
  } catch {
    shown = Array.from(name, (b) => (b < 0x80 ? String.fromCharCode(b) : "?")).join("");
  }
  return new UploadPackError(
    "ambiguous-deepen-not",
    `git upload-pack: ambiguous deepen-not: deepen-not ${shown}`,
  );
}

/**
 * The commits `deepen-not` names refer to. Each name must expand to
 * exactly one ref under git's rules (`expand_ref`), or the request is
 * refused, as git refuses it; a tag is peeled to its commit. Names that are
 * not valid UTF-8 match no ref (ref names are UTF-8 here).
 */
export async function resolveDeepenNot(
  names: readonly Uint8Array[],
  refs: RefSnapshot,
  tips: RefTips,
): Promise<Oid[]> {
  const out: Oid[] = [];
  for (const raw of names) {
    let name: string;
    try {
      name = utf8.decode(raw);
    } catch {
      throw ambiguous(raw);
    }
    const matches = new Set<string>();
    let oid: Oid | undefined;
    for (const rule of RULES) {
      const full = rule(name);
      const target =
        full === "HEAD"
          ? refs.head === null
            ? undefined
            : refs.refs.get(refs.head)
          : refs.refs.get(full);
      if (target && !matches.has(full)) {
        matches.add(full);
        oid = target;
      }
    }
    if (matches.size !== 1 || oid === undefined) throw ambiguous(raw);
    const commits = new Set((await tips.commits()).map(oidToHex));
    if (commits.has(oidToHex(oid))) {
      out.push(oid);
      continue;
    }
    const tip = (await tips.peeled()).get(oidToHex(oid));
    if (tip?.targetType === "commit") out.push(tip.target);
  }
  return out;
}
