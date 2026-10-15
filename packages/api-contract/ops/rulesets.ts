import { HANDLE_PATTERN, PRINCIPAL_TYPES, REPO_ROLES, RULE_TYPES } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z.string().regex(HANDLE_PATTERN).describe("The owner's handle.");
const RepoName = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const RulesetId = z.coerce.number().int().positive().describe("The ruleset's id.");

const Pattern = z
  .string()
  .min(1)
  .max(255)
  .describe(
    "A full ref name pattern (`refs/heads/main`, `refs/heads/release/*`, `refs/tags/**`), `~DEFAULT_BRANCH` or `~ALL`. `*` stays within a path segment; `**` crosses them.",
  );

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
    .array(
      z.object({
        type: z
          .enum(RULE_TYPES)
          .describe(
            "`creation`, `update`, `deletion` (of a matching ref), `non_fast_forward` (no force pushes), `required_signatures` (every new commit verified), `pull_request` (no direct pushes; changes come through pull requests).",
          ),
      }),
    )
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

/** Signatures are of commits: only branch rulesets require them. */
const signaturesOnBranches = (input: { target: string; rules: readonly { type: string }[] }) =>
  input.target === "branch" || !input.rules.some((r) => r.type === "required_signatures");
const SIGNATURES_ON_BRANCHES = "required_signatures applies to branch rulesets only.";

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
