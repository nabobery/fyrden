import type { IdPrefix } from "../ids.js";

/** Principal types. */
export const PRINCIPAL_TYPES = ["user", "org", "agent", "installation"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const PRINCIPAL_ID_PREFIX = {
  user: "usr",
  org: "org",
  agent: "agt",
  installation: "ins",
} as const satisfies Record<PrincipalType, IdPrefix>;

export interface Principal {
  id: string;
  type: PrincipalType;
  /** Login name; installations have none. */
  handle: string | null;
  isInstanceAdmin: boolean;
}

/** GitHub-style handle: 1-39 chars, alphanumerics and single inner hyphens. */
export const HANDLE_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}
