/**
 * Repositories agents create acting for a user: scratch work by default,
 * so each expires unless the agent says when, and each agent has a limit
 * of its own besides the user's quota.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Proposed; operators override them (`AGENT_REPO_TTL_DAYS`, `QUOTA_AGENT_MAX_REPOS`). */
export const AGENT_REPO_DEFAULTS = {
  /** How long a repository an agent creates lives when it gives no expiry. */
  ttlMs: 7 * DAY_MS,
  /** Active repositories one agent may have created. */
  maxRepos: 100,
} as const;

export interface AgentRepoLimits {
  readonly ttlMs: number;
  readonly maxRepos: number;
}

/** The instance's limits: the defaults, overridden by any Worker variable set (a whole number, at least the minimum). */
export function agentRepoLimits(env: object): AgentRepoLimits {
  const vars = env as Partial<Record<string, unknown>>;
  const read = (name: string, min: number): number | undefined => {
    const raw = vars[name];
    const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(value) && value >= min ? value : undefined;
  };
  const days = read("AGENT_REPO_TTL_DAYS", 1);
  return {
    ttlMs: days === undefined ? AGENT_REPO_DEFAULTS.ttlMs : days * DAY_MS,
    maxRepos: read("QUOTA_AGENT_MAX_REPOS", 0) ?? AGENT_REPO_DEFAULTS.maxRepos,
  };
}
