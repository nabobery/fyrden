import {
  checkNameKey,
  checkText,
  FYRDEN_CI_SOURCE,
  HANDLE_SHAPE,
  isId,
  MAX_CHECK_NAME_LENGTH,
  MAX_HANDLE_LENGTH,
  MAX_REQUIRED_CHECKS,
  MERGE_METHODS,
  PRINCIPAL_ID_PREFIX,
  PRINCIPAL_TYPES,
  REPO_ROLES,
  RULE_TYPES,
  type RuleType,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The owner's handle.");
const RepoName = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const RulesetId = z.coerce.number().int().positive().describe("The ruleset's id.");

const Pattern = z
  .string()
  .min(1)
  .max(255)
  .describe(
    "A full ref name pattern (`refs/heads/main`, `refs/heads/release/*`, `refs/tags/**`), `~DEFAULT_BRANCH` or `~ALL`. `*` stays within a path segment; `**` crosses them.",
  );

// Strict: a requirement Fyrden does not enforce is refused, never stored as if it held.
const PullRequestParameters = z
  .strictObject({
    required_approving_review_count: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(0)
      .describe(
        "Approving reviews a merge needs, from people with write access other than the author.",
      ),
    dismiss_stale_reviews_on_push: z
      .boolean()
      .default(false)
      .describe("A push makes earlier reviews stop counting."),
    require_last_push_approval: z
      .boolean()
      .default(false)
      .describe(
        "Someone other than the last pusher must approve the current head after the last push (an approval of an earlier head does not count).",
      ),
    required_review_thread_resolution: z
      .boolean()
      .default(false)
      .describe("Every review thread must be resolved."),
    require_code_owner_review: z
      .boolean()
      .default(false)
      .describe(
        "A changed path with designated code owners needs an approval from one of them (CODEOWNERS at the base branch's tip: users, agents when agents' approvals count, or teams of the repository's organization, with write access).",
      ),
    allowed_merge_methods: z
      .array(z.enum(MERGE_METHODS))
      .min(1)
      .max(MERGE_METHODS.length)
      .refine((methods) => new Set(methods).size === methods.length, "A method is given twice.")
      .default([...MERGE_METHODS]),
    required_reviewers: z
      .array(z.never())
      .max(0)
      .optional()
      .describe("Reviews required from specific teams are not supported yet: empty or left out."),
    allow_agent_approvals: z
      .boolean()
      .default(false)
      .describe(
        "Fyrden: reviews submitted by agents count toward approvals (a person's own agents count as that person). By default only people's reviews count.",
      ),
  })
  .describe(
    "For `pull_request` only: what a merge needs; left out, nothing beyond the pull request.",
  );

const Publisher = z
  .string()
  .refine(
    (id) =>
      id === FYRDEN_CI_SOURCE ||
      Object.values(PRINCIPAL_ID_PREFIX).some((prefix) => isId(id, prefix)),
    "Not a publisher: `ci` (Fyrden's own runs) or a principal's id.",
  )
  .describe(
    "Fyrden: the publisher the check must come from, `ci` for Fyrden's own runs or the id of the principal that posts it (an agent, not the user it acts for); left out, any. GitHub's integer app ids name no publisher here.",
  );

const RequiredStatusChecksParameters = z
  .strictObject({
    required_status_checks: z
      .array(
        z.strictObject({
          context: z
            .string()
            .refine(
              (context) => checkText(context, MAX_CHECK_NAME_LENGTH).ok,
              `1-${MAX_CHECK_NAME_LENGTH} characters, no control characters.`,
            )
            .describe("The status context or check name, compared case-insensitively."),
          integration_id: Publisher.optional(),
        }),
      )
      .min(1)
      .max(MAX_REQUIRED_CHECKS)
      .refine(
        (checks) =>
          new Set(checks.map((c) => `${checkNameKey(c.context)} ${c.integration_id ?? ""}`))
            .size === checks.length,
        "A check is required twice from the same source.",
      ),
    strict_required_status_checks_policy: z
      .boolean()
      .default(true)
      .describe(
        "A pull request merged into the branch must contain its latest commit, as `require_up_to_date` asks. GitHub's default for the rule.",
      ),
    do_not_enforce_on_create: z
      .boolean()
      .default(false)
      .describe("A branch being created skips this rule."),
  })
  .describe(
    "For `required_status_checks` only: the checks a commit must pass (success, skipped or neutral) before a matching branch may point at it, by a push or a merge (a merge judges the pull request's head).",
  );

const RULE_DESCRIPTION =
  "`creation`, `update`, `deletion` (of a matching ref), `non_fast_forward` (no force pushes), `required_signatures` (every new commit verified), `pull_request` (no direct pushes; changes come through pull requests, merged as its `parameters` require), `required_status_checks` (named checks must pass on the commit first), Fyrden's `require_up_to_date` (a pull request merged into the branch must already contain the branch's latest commit).";

/** Rules that take no parameters. */
const PLAIN_RULES = RULE_TYPES.filter(
  (type): type is Exclude<RuleType, "pull_request" | "required_status_checks"> =>
    type !== "pull_request" && type !== "required_status_checks",
) as [
  Exclude<RuleType, "pull_request" | "required_status_checks">,
  ...Exclude<RuleType, "pull_request" | "required_status_checks">[],
];

const Rule = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pull_request").describe(RULE_DESCRIPTION),
    parameters: PullRequestParameters.optional(),
  }),
  z.object({
    type: z.literal("required_status_checks").describe(RULE_DESCRIPTION),
    parameters: RequiredStatusChecksParameters,
  }),
  z.strictObject({ type: z.enum(PLAIN_RULES).describe(RULE_DESCRIPTION) }),
]);

const RulesetBody = {
  name: z.string().min(1).max(100).describe("Unique in the repository."),
  target: z.enum(["branch", "tag"]).default("branch"),
  enforcement: z
    .enum(["active", "evaluate", "disabled"])
    .describe(
      "`active` blocks, `evaluate` only reports what it would block, `disabled` does nothing.",
    ),
  conditions: z.object({
    ref_name: z.object({
      include: z.array(Pattern).min(1).max(50),
      exclude: z.array(Pattern).max(50).default([]),
    }),
  }),
  rules: z
    .array(Rule)
    .min(1)
    .max(RULE_TYPES.length)
    .refine(
      (rules) => new Set(rules.map((r) => r.type)).size === rules.length,
      "A rule type is given twice.",
    ),
  bypass_actors: z
    .array(
      z.object({
        actor_type: z.literal("RepositoryRole"),
        actor_id: z
          .enum(REPO_ROLES)
          .describe("Callers with this role or a stronger one bypass the ruleset."),
        bypass_mode: z.literal("always").default("always"),
      }),
    )
    .max(10)
    .default([]),
  actor_types: z
    .array(z.enum(PRINCIPAL_TYPES))
    .min(1)
    .max(PRINCIPAL_TYPES.length)
    .refine((types) => new Set(types).size === types.length, "Each type at most once.")
    .optional()
    .describe(
      'Fyrden: the principal types it applies to (all when left out); `["agent"]` makes agents use pull requests.',
    ),
};

export const Ruleset = z.object({
  id: z.number().int(),
  ...RulesetBody,
  actor_types: RulesetBody.actor_types.nullable(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
});

const RepoInput = { owner: Owner, repo: RepoName };

/**
 * Signatures and checks are of commits: only branch rulesets require them
 * (a tag may point at a tag object, which has neither).
 */
const signaturesOnBranches = (input: { target: string; rules: readonly { type: string }[] }) =>
  input.target === "branch" ||
  !input.rules.some((r) => r.type === "required_signatures" || r.type === "required_status_checks");
const SIGNATURES_ON_BRANCHES =
  "required_signatures and required_status_checks apply to branch rulesets only.";

export const listRulesets = defineOperation({
  id: "repos.rulesets.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/rulesets",
  summary: "List rulesets",
  description: "The repository's rulesets, by id.",
  input: z.object(RepoInput),
  output: z.object({ rulesets: z.array(Ruleset) }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_rulesets",
    title: "List rulesets",
    description: "List a repository's rulesets.",
    readOnly: true,
  },
});

const RuleSuite = z.object({
  id: z.number().int(),
  ref: z.string(),
  before_sha: z
    .string()
    .nullable()
    .describe("The ref's commit before the push; null for a new ref."),
  after_sha: z.string().nullable().describe("The commit pushed; null for a deletion."),
  actor_id: z.string().describe("Who pushed (the user an agent acted for, under a grant)."),
  pushed_at: z.number().int().describe("Unix time in milliseconds."),
  result: z.enum(["pass", "fail"]).describe("Whether active rulesets let the update through."),
  evaluation_result: z
    .literal("fail")
    .describe("What `evaluate` rulesets would have done: only refusals are recorded."),
  rule_evaluations: z.array(
    z.object({
      rule_source: z.object({ type: z.literal("ruleset"), id: z.number().int(), name: z.string() }),
      enforcement: z.literal("evaluate"),
      result: z.literal("fail"),
      rule_type: z.string(),
      details: z.string(),
    }),
  ),
});

export const listRuleSuites = defineOperation({
  id: "repos.rulesets.rule_suites.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/rulesets/rule-suites",
  summary: "List rule suites",
  description:
    "What rulesets in `evaluate` mode would have refused of pushes to the repository, newest first: one suite per ref update one of them objected to (the newest 1,000 are kept). Nothing is recorded for an update they all let through.",
  input: z.object({
    ...RepoInput,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    rule_suites: z.array(RuleSuite),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_rule_suites",
    title: "List rule suites",
    description:
      "List what a repository's rulesets in evaluate mode would have refused of recent pushes.",
    readOnly: true,
  },
});

export const getRuleset = defineOperation({
  id: "repos.rulesets.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/rulesets/{ruleset_id}",
  summary: "Get a ruleset",
  description: "One of the repository's rulesets.",
  input: z.object({ ...RepoInput, ruleset_id: RulesetId }),
  output: Ruleset,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_ruleset",
    title: "Get a ruleset",
    description: "Get one of a repository's rulesets.",
    readOnly: true,
  },
});

export const createRuleset = defineOperation({
  id: "repos.rulesets.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/rulesets",
  summary: "Create a ruleset",
  description:
    "Adds rules on the branches or tags whose names match: pushes, file writes and every other change of a matching ref are checked against them (refused ones are `ng`, naming the ruleset). Rules on names and kinds of change are checked before a push is stored; force pushes and signatures at its commit, with the rulesets current then. At most 50 per repository. Administrators only.",
  input: z
    .object({ ...RepoInput, ...RulesetBody })
    .refine(signaturesOnBranches, SIGNATURES_ON_BRANCHES),
  output: Ruleset,
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_ruleset",
    title: "Create a ruleset",
    description: "Protect branches or tags of a repository you administer with rules.",
    readOnly: false,
  },
});

export const updateRuleset = defineOperation({
  id: "repos.rulesets.update",
  method: "PUT",
  path: "/repos/{owner}/{repo}/rulesets/{ruleset_id}",
  summary: "Update a ruleset",
  description: "Replaces a ruleset. Administrators only.",
  input: z
    .object({ ...RepoInput, ruleset_id: RulesetId, ...RulesetBody })
    .refine(signaturesOnBranches, SIGNATURES_ON_BRANCHES),
  output: Ruleset,
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_ruleset",
    title: "Update a ruleset",
    description: "Replace a ruleset of a repository you administer.",
    readOnly: false,
    // Each replacement makes a new version (a push being checked then retries).
    idempotent: false,
  },
});

export const deleteRuleset = defineOperation({
  id: "repos.rulesets.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/rulesets/{ruleset_id}",
  summary: "Delete a ruleset",
  description: "Removes a ruleset. Administrators only.",
  input: z.object({ ...RepoInput, ruleset_id: RulesetId }),
  output: z.object({ id: z.number().int(), state: z.literal("deleted") }),
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_ruleset",
    title: "Delete a ruleset",
    description: "Remove a ruleset of a repository you administer.",
    readOnly: false,
  },
});
