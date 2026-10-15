/**
 * Who a commit the server makes is by. The platform signs it, so the
 * platform is its committer; its author is the agent acting, or the person
 * when no agent acts. An agent acting for a person (a delegated token)
 * names that person in a `Co-authored-by` trailer; an agent with its own
 * token acts for no one, so it names none. Trailers are not authenticated:
 * the audit log is the record of who acted for whom.
 */

export interface GitPerson {
  readonly name: string;
  readonly email: string;
}

export interface CommitParty {
  readonly id: string;
  /** Its handle; the id stands in for a principal without one. */
  readonly handle: string | null;
}

export interface CommitIdentity {
  readonly author: GitPerson;
  readonly committer: GitPerson;
  /** People to name in `Co-authored-by` trailers. */
  readonly coAuthors: readonly GitPerson[];
}

/** The platform's identity as a committer on `host`. */
export function platformCommitter(host: string): GitPerson {
  return { name: "Fyrden", email: `noreply@${host}` };
}

/** A principal's no-reply identity on `host` (as GitHub's `users.noreply`). */
export function noReplyPerson(party: CommitParty, host: string): GitPerson {
  return { name: party.handle ?? party.id, email: `${party.id}@users.noreply.${host}` };
}

export function serverCommitIdentity(input: {
  readonly host: string;
  /** The token's principal: a person, or an agent using its own token. */
  readonly principal: CommitParty;
  /** The agent acting for `principal` under a delegation (a delegated token's first agent); null for none. */
  readonly actingAgent: CommitParty | null;
}): CommitIdentity {
  const { host, principal, actingAgent } = input;
  return {
    author: noReplyPerson(actingAgent ?? principal, host),
    committer: platformCommitter(host),
    coAuthors: actingAgent ? [noReplyPerson(principal, host)] : [],
  };
}

/**
 * `Co-authored-by` trailer lines for the people `message` does not name
 * yet (by email, ignoring case). Where they go in the message is git's
 * trailer rules' business (git-core `appendTrailers`).
 */
export function coAuthorTrailers(message: string, coAuthors: readonly GitPerson[]): string[] {
  const named = message.toLowerCase();
  return coAuthors
    .filter((p) => !named.includes(`<${p.email.toLowerCase()}>`))
    .map((p) => `Co-authored-by: ${p.name} <${p.email}>`);
}
