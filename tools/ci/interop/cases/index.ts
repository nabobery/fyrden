import { t5500 } from "./t5500-fetch-pack.ts";
import { t5516 } from "./t5516-fetch-push.ts";
import { t5533 } from "./t5533-push-cas.ts";
import { t5537 } from "./t5537-fetch-shallow.ts";
import { t5538 } from "./t5538-push-shallow.ts";
import { t5543 } from "./t5543-atomic-push.ts";
import { t5545 } from "./t5545-push-options.ts";
import { t5546 } from "./t5546-receive-limits.ts";
import { t5551 } from "./t5551-http-fetch-smart.ts";
import { t5700 } from "./t5700-protocol-v1.ts";
import { t5702 } from "./t5702-protocol-v2.ts";
import { t5704 } from "./t5704-protocol-violations.ts";
import type { CaseFile } from "./types.ts";

/** The catalogue, one entry per git test script. */
export const CATALOGUE: readonly CaseFile[] = [
  t5500,
  t5516,
  t5533,
  t5537,
  t5538,
  t5543,
  t5545,
  t5546,
  t5551,
  t5700,
  t5702,
  t5704,
];

export { BODY_LIMIT } from "./t5546-receive-limits.ts";
export type { CaseFile, InteropCase, NotPorted } from "./types.ts";
