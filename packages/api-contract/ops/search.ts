import { ISSUE_STATE_REASONS, LOCK_REASONS } from "@fyrden/domain";
import { z } from "zod";
import { AUTHENTICATED, defineOperation, INSTANCE_ADMIN, INSTANCE_READ } from "../src/op.js";

export const backfillSearch = defineOperation({
  id: "admin.search.backfill",
  method: "POST",
  path: "/admin/search/backfill",
  summary: "Ask search to reconcile every repository",
  description:
    "Fyrden: asks for a reconciliation of every active repository's search projections, a page of repositories at a time (call again with `cursor` until `next_cursor` is null); `requested` counts the repositories newly asked (one already waiting is not asked again). The reconciliations run in the five-minute maintenance within search's daily allowance. Refused (409) while search indexing is off: run it once indexing is on, after which repositories made meanwhile are projected from their events (or reconciled, when published late). Instance administrators only.",
  input: z.object({
    cursor: z.string().max(200).optional(),
  }),
  output: z.object({
    requested: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});

export const setSearchIndexing = defineOperation({
  id: "admin.search.indexing",
  method: "PUT",
  path: "/admin/search/indexing",
  summary: "Turn search indexing on or off",
  description:
    "Fyrden: turns the deployment's search indexing on (`enabled: true`: events project issues, pull requests, labels and milestones into search, and the five-minute maintenance repairs them within search's daily allowance) or off (nothing more is projected or repaired, though an event batch or repair run already past its check may finish; what is projected stays). Projections miss what happens while it is off: after turning it on, ask for a backfill (`POST /admin/search/backfill`). Setting the state it is in changes nothing. Instance administrators only.",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

const BarrierPhase = z.enum(["running", "pausing", "paused", "recovering"]);

export const getSearchStatus = defineOperation({
  id: "admin.search.status",
  method: "GET",
  path: "/admin/search/status",
  summary: "Get the read model's and search's state",
  description:
    "Fyrden: the org read model's write protocol and search's state, for operators. `protocol`: the executor version this deployment serves, the version the last deploy verified as serving (0 until one did), the oldest the read model admits, whether writes outside the executor are only counted (`compatibility`) or refused (`enforced`), the restore floor, and the restore token (`restore_token`: none written yet, `uninitialized`, until the first handshake; `matched`; a handshake under way, `intent`; or `mismatch`, the read model restored or changed since the last handshake, best effort). `barrier`: the directory's and the read model's barriers (null where a row is missing, and then not `consistent`). `admission`: whether a write is under way, writes made outside the executor while they were only counted (`stray`), and the read model's write sequence. `writers`: leases live and expired, and the earliest deadline. `export`: whether a coherent export of the read model can be made (not before a restore floor is recorded: `no_restore_floor`). `recovery`: the latest recovery of the read model (`admin.read_model.recovery.*`), its id, generation and stage, or null when there never was one. `search`: today's spending of its allowance and of the repository index's, with the limits (`limits`: rows and reads a day, the size at which it admits no more growth (the size observed and the growth reserved since, together; removals are still made), the repository index's rows a day and the repositories it holds at most); the size last observed and the growth reserved since; the issues and pull requests counted in the full-text index (`live_docs`) and the repositories (`indexed_repos`); whether a reconciliation is due and since when the one due next has waited; the parked one whose wait ends first (`next_parked`: a pass ended partial, with why, and when it may be tried again); and a repository whose projections and full-text entries are not known whole (`first_uncovered`: each is certified on its own by a whole reconciliation, so none listed does not mean a backfill reached every repository); the read model's recovery generation (`recovery_gen`), a repository hidden since a recovery until its reconciliation (`first_hidden`), and the purge of a tombstoned repository's search rows next (`next_purge`). Instance administrators only.",
  input: z.object({}),
  output: z.object({
    indexing: z.boolean(),
    protocol: z.object({
      serving_version: z.number().int(),
      deployed_version: z.number().int().nullable(),
      required_version: z.number().int().nullable(),
      mode: z.enum(["compatibility", "enforced"]),
      restore_floor: z.string().nullable(),
      restore_token: z.enum(["uninitialized", "matched", "intent", "mismatch"]),
    }),
    barrier: z.object({
      directory_phase: BarrierPhase.nullable(),
      directory_generation: z.number().int().nullable(),
      org_phase: BarrierPhase.nullable(),
      org_generation: z.number().int().nullable(),
      consistent: z.boolean(),
    }),
    admission: z.object({
      open: z.boolean().nullable(),
      stray: z.number().int().nullable(),
      sequence: z.number().int().nullable(),
    }),
    writers: z.object({
      live: z.number().int(),
      expired: z.number().int(),
      earliest_deadline: z.number().int().nullable(),
    }),
    export: z.object({
      available: z.boolean(),
      reason: z.enum(["no_restore_floor"]).nullable(),
    }),
    recovery: z
      .object({
        recovery_id: z.string(),
        generation: z.number().int(),
        stage: z.enum([
          "preserving",
          "awaiting_restore",
          "importing",
          "fencing",
          "resuming",
          "complete",
        ]),
      })
      .nullable(),
    search: z.object({
      day: z.number().int(),
      rows: z.number().int(),
      reads: z.number().int(),
      repo_rows: z.number().int(),
      bytes: z.number().int(),
      bytes_reserved: z.number().int(),
      observed_sequence: z.number().int(),
      live_docs: z.number().int(),
      indexed_repos: z.number().int(),
      limits: z.object({
        daily_rows: z.number().int(),
        daily_reads: z.number().int(),
        max_bytes: z.number().int(),
        repository_daily_rows: z.number().int(),
        repository_capacity: z.number().int(),
      }),
      repair_pending: z.boolean(),
      next_repair_since: z.number().int().nullable(),
      next_parked: z
        .object({ repo_id: z.string(), reason: z.string(), retry_at: z.number().int() })
        .nullable(),
      first_uncovered: z.string().nullable(),
      recovery_gen: z.number().int(),
      first_hidden: z.string().nullable(),
      next_purge: z.string().nullable(),
    }),
  }),
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

const SearchIndex = z.enum(["documents", "repositories", "both"]);
const IndexResults = z.object({
  indexes: z.array(z.object({ index: z.enum(["documents", "repositories"]), ok: z.boolean() })),
});

export const checkSearchIndex = defineOperation({
  id: "admin.search.check_index",
  method: "POST",
  path: "/admin/search/indexes/check",
  summary: "Check search's full-text indexes against their projections",
  description:
    "Fyrden: checks a full-text index (`documents`: issues' and pull requests' titles and bodies; `repositories`: names and descriptions; `both`, in that order) against the projections it is built from, each on its own: `ok` false when the index is damaged or does not match them, which it also does while some live projections are not in it yet (projected before the index existed, or their growth refused): ask for a backfill (`POST /admin/search/backfill`), or rebuild a small index (`POST /admin/search/indexes/rebuild`). Allowed at the size threshold; charged to search's allowance. Refused (503 `read_model_maintenance`) while the read model is under maintenance. Instance administrators only.",
  input: z.object({ index: SearchIndex }),
  output: IndexResults,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});

export const rebuildSearchIndex = defineOperation({
  id: "admin.search.rebuild_index",
  method: "POST",
  path: "/admin/search/indexes/rebuild",
  summary: "Rebuild a small full-text index of search's from its projections",
  description:
    "Fyrden: rebuilds a full-text index (`documents`, `repositories`, or `both`, in that order) from the projections it is built from, at once, and marks every live projection indexed: for small deployments only (at most 256 live projections and 1 MiB of their text an index; refused, 409 `index_rebuild_too_large`, past either: ask for a backfill instead, which reconciles each repository within the day's allowance). Refused (409 `index_reconcile_required`) while a live issue or pull request has no repository number yet (its repository's reconciliation gives it one), and (409 `index_rebuild_refused`) when search's allowance or the database's size admits no rebuild. Both indexes are looked at before either is rebuilt; one refused at its rebuild leaves the one before it rebuilt. It repairs the index, not the projections: no repository becomes known whole by it. `ok` is true for each index rebuilt. Refused (503 `read_model_maintenance`) while the read model is under maintenance. Instance administrators only.",
  input: z.object({ index: SearchIndex }),
  output: IndexResults,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});

const SEARCH_DEPTH = 1_000;

const SearchQuery = z
  .string()
  .min(1)
  // 256 characters (code points) at most, which the search itself counts.
  .max(512)
  .describe(
    'The query, 256 characters at most: free text (words, `"quoted phrases"`, a last word ending in `*` for a prefix of at least three letters) and qualifiers. A scope is required: `repo:owner/name`, `org:handle` or `user:handle` (repeated, they intersect). Text is matched in letters and digits up to U+024F (Latin, its accents folded); anything else is refused (`unsupported_search_text`). It names 4 different repositories at most.',
  );

const SearchPage = {
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe(
      "Results a page, 1-100. A page whose items would pass 1 MiB as JSON is refused whole (`page_too_large`): ask for fewer.",
    ),
  page: z.coerce.number().int().min(1).default(1).describe("The page, from 1."),
};

/** A page past the matches a search counts is refused. */
const withinDepth = (input: { page: number; per_page: number }) =>
  (input.page - 1) * input.per_page < SEARCH_DEPTH;
const DEPTH_MESSAGE = `Only the first ${SEARCH_DEPTH} results can be paged through.`;

const SearchPrincipal = z.object({
  id: z.string(),
  login: z.string().describe("Its handle now; `ghost` for one deleted."),
});

const SearchRepositoryRef = z.object({
  id: z.string(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
  full_name: z.string(),
});

export const SearchIssue = z.object({
  id: z.number().int().describe("Fyrden: the number again (issues have no separate id space)."),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]).describe("A merged pull request is `closed`."),
  state_reason: z.enum(ISSUE_STATE_REASONS).nullable(),
  user: SearchPrincipal.describe("Who opened it."),
  assignees: z.array(SearchPrincipal),
  labels: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      color: z.string(),
      description: z.string().nullable(),
    }),
  ),
  milestone: z
    .object({
      number: z.number().int(),
      title: z.string(),
      state: z.enum(["open", "closed"]),
      description: z.string().nullable(),
      due_on: z.number().int().nullable(),
      closed_at: z.number().int().nullable(),
    })
    .nullable(),
  locked: z.boolean(),
  active_lock_reason: z.enum(LOCK_REASONS).nullable(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
  closed_at: z.number().int().nullable().describe("Unix time in milliseconds."),
  draft: z.boolean().optional().describe("Pull requests only."),
  pull_request: z
    .object({ merged_at: z.number().int().nullable() })
    .optional()
    .describe("Present when this is a pull request."),
  repository: SearchRepositoryRef,
});

export const SearchRepository = z.object({
  id: z.string(),
  owner: z.object({ id: z.string(), login: z.string() }),
  name: z.string(),
  full_name: z.string(),
  visibility: z.enum(["public", "internal", "private"]),
  description: z.string().nullable(),
  default_branch: z.string(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
});

const searchResults = <T extends z.ZodType>(item: T) =>
  z.object({
    total_count: z.number().int().describe(`The matches, counted to ${SEARCH_DEPTH} at most.`),
    incomplete_results: z
      .boolean()
      .describe(
        "Whether matches may be missing: search does not index now, a repository of the scope is not yet known whole to search, more matched than are counted, or the ranking's candidates were all a search takes.",
      ),
    items: z.array(item),
  });

const SEARCH_ERRORS =
  "A query with no scope is refused (`search_scope_required`), as is one whose owner holds more than 1,000 repositories the caller may read (`search_scope_too_broad`: name a repository), a prefix standing for more than 1,000 words (`prefix_too_broad`), and a query matching too much of the index to rank (`query_too_broad`); a named repository the caller cannot read is not found (`repo_not_found`). Searches are limited to 10 a minute a principal (`search_rate_limited`) and to an allowance of reads a day (`search_budget`, until the next UTC day). Results are counted to 1,000 and ranked by relevance; writes between pages can repeat or omit results.";

export const searchIssues = defineOperation({
  id: "search.issues",
  method: "GET",
  path: "/search/issues",
  summary: "Search issues and pull requests",
  description: `Issues and pull requests (marked with \`pull_request\`) whose title or body match the query's text, in the repositories of its scope the caller may read: issues with \`issues:read\`, pull requests with \`pull_requests:read\`, each repository's as the caller's role there allows now. Qualifiers: \`is:issue\`, \`is:pr\`, \`is:open\`, \`is:closed\` (merged pull requests too), \`is:merged\`, \`label:name\` (\`label:#id\`), \`milestone:title\` (or its number), \`author:handle\`, \`assignee:handle\`, \`in:title\`, \`in:body\`. The text is required for now. ${SEARCH_ERRORS}`,
  input: z
    .object({ q: SearchQuery, ...SearchPage })
    .refine(withinDepth, { message: DEPTH_MESSAGE }),
  output: searchResults(SearchIssue),
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  freshAuth: true,
  noStore: true,
  mcp: {
    tool: "search_issues",
    title: "Search issues and pull requests",
    description:
      "Searches issues and pull requests by text within a scope (repo:owner/name, org:handle or user:handle), with qualifiers such as is:open, label:, author:.",
    readOnly: true,
  },
});

export const searchRepositories = defineOperation({
  id: "search.repositories",
  method: "GET",
  path: "/search/repositories",
  summary: "Search repositories",
  description: `Repositories whose name or description match the query's text (\`in:name\`, \`in:description\` to choose), among those of its scope whose metadata the caller may read now. ${SEARCH_ERRORS}`,
  input: z
    .object({ q: SearchQuery, ...SearchPage })
    .refine(withinDepth, { message: DEPTH_MESSAGE }),
  output: searchResults(SearchRepository),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  freshAuth: true,
  noStore: true,
  mcp: {
    tool: "search_repositories",
    title: "Search repositories",
    description:
      "Searches repositories by name and description within a scope (org:handle or user:handle, or repo:owner/name).",
    readOnly: true,
  },
});
