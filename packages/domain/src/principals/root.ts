import { principalTypeOf } from "./principal.js";

/**
 * The identity a change is by when someone's own agents act: one person
 * and all the agents working for them are one root. A delegated token acts
 * for its user (`principalId`); an agent's own token is its owner's when a
 * user owns the agent, else the agent's own (an organization's agent stands
 * for no person); any other token is its principal's.
 */
export function rootIdentity(token: {
  readonly principalId: string;
  readonly grantId: string | null;
  readonly ceilingIds: readonly string[];
}): string {
  if (token.grantId !== null) return token.principalId;
  const [owner, ...rest] = token.ceilingIds;
  if (principalTypeOf(token.principalId) === "agent" && rest.length === 0 && owner !== undefined)
    return principalTypeOf(owner) === "user" ? owner : token.principalId;
  return token.principalId;
}
