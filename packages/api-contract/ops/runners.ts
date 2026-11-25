import { HANDLE_SHAPE, MAX_HANDLE_LENGTH, MAX_RUNNER_REPOS } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, NoContent } from "../src/op.js";

const Org = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The organization's handle.");
const RunnerId = z.coerce.number().int().positive().describe("The runner's id.");

const RepositoryId = z
  .string()
  .min(1)
  .max(64)
  .describe("A repository's id (`rep_…`, from `GET /repos/{owner}/{repo}`).");
const RepositoryAccess = z
  .enum(["all", "selected"])
  .describe(
    "Which of the organization's repositories the runner may take jobs of: `all`, or `selected` (those listed). Public ones only with `allows_public` too.",
  );
const SelectedIds = z
  .array(RepositoryId)
  .max(MAX_RUNNER_REPOS)
  .describe(
    `With \`repository_access\` \`selected\`: the repositories, ${MAX_RUNNER_REPOS} at most.`,
  );
const AllowsPublic = z
  .boolean()
  .describe(
    "Whether the runner may take jobs of public repositories. A public repository's workflows can run code its maintainers did not write (actions, dependencies); on a long-lived runner, what one job leaves behind reaches the jobs after it.",
  );
const AllowsForks = z
  .boolean()
  .describe(
    "Whether the runner may take jobs of pull requests from forks (`pull_request` and `pull_request_target`), once approved. Only an ephemeral runner may: it is given one job. A machine registered again is still the same machine, so use a fresh one each time. A fork of a public repository needs `allows_public` as well.",
  );

const SWITCH_NOTE =
  " While the deployment has not turned self-hosted runners on (`FYRDEN_CI_RUNNERS`), a registration token is refused with 409 `runners_off`. On Free, a registration token is refused with 409 `runner_fleet_full` while the deployment's runner fleet is full (`FYRDEN_CI_FLEET`, 2 unless set), or while today's polls (UTC) of runners it no longer has leave no slot; registration decides, so a token minted earlier may still be refused.";

export const RunnerRegistrationToken = z.object({
  token: z
    .string()
    .describe(
      "The registration token (`fyrden_run_` prefix): registers one runner, once. Shown once and never stored.",
    ),
  expires_at: z.number().int().describe("Unix time in milliseconds: an hour after it was made."),
});

export const createRunnerRegistrationToken = defineOperation({
  id: "orgs.runners.registration_tokens.create",
  method: "POST",
  path: "/orgs/{org}/actions/runners/registration-token",
  summary: "Create a runner registration token",
  description: `Mints a token that registers one self-hosted runner for the organization (\`gitea/runner register --token\`), within the hour. The runner starts with the access given here: by default every private and internal repository of the organization, no public one and no fork job; its labels only narrow that. A token with \`allows_forks\` registers only an ephemeral runner (\`--ephemeral\`); any other Register is refused and does not spend it. 422 \`unknown_repository\` for an id that is not an active repository of the organization, 422 \`invalid_input\` for \`selected_repository_ids\` without \`repository_access\` \`selected\`. A repository that left the organization before Register is dropped. Owners only.${SWITCH_NOTE}`,
  input: z.object({
    org: Org,
    repository_access: RepositoryAccess.optional(),
    selected_repository_ids: SelectedIds.optional(),
    allows_public: AllowsPublic.optional(),
    allows_forks: AllowsForks.optional(),
  }),
  output: RunnerRegistrationToken,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  secretResponse: true,
  // Not an MCP tool: a credential would land in a model's context.
  mcp: false,
});

export const SelfHostedRunner = z.object({
  id: z.number().int(),
  name: z.string(),
  labels: z.array(z.string()).describe("As the runner last declared them."),
  version: z.string().describe("The runner's version, as it last declared it."),
  ephemeral: z.boolean().describe("Registered to take one job."),
  created_at: z.number().int().describe("Unix time in milliseconds: when it registered."),
  declared_at: z
    .number()
    .int()
    .nullable()
    .describe(
      "Unix time in milliseconds: when its daemon last started; null when it never has (a registration whose answer was lost: delete it).",
    ),
  revoked_at: z
    .number()
    .int()
    .nullable()
    .describe(
      "Unix time in milliseconds: when it was deleted or revoked, or when an ephemeral runner's report window ended (set automatically); its credential stopped working then.",
    ),
  repository_access: RepositoryAccess,
  selected_count: z
    .number()
    .int()
    .describe("How many repositories it lists (0 unless `repository_access` is `selected`)."),
  allows_public: AllowsPublic,
  allows_forks: AllowsForks,
  task_assigned_at: z
    .number()
    .int()
    .nullable()
    .describe(
      "Unix time in milliseconds: when an ephemeral runner was assigned its one job; null before, and for a long-lived runner.",
    ),
  revoked_reason: z
    .enum(["deleted", "poll_rate", "fleet_cap", "spent"])
    .nullable()
    .describe(
      "Why it was revoked: `deleted` by an owner; `poll_rate`, it asked for work more often than the deployment allows in a UTC day; `fleet_cap`, past the deployment's runner fleet size; `spent`, an ephemeral runner whose one job and report window ended. Null while no revocation is recorded: an ephemeral runner past its report window may read null for a few minutes until maintenance records it `spent`, though its credentials already stopped working.",
    ),
});

export const listRunners = defineOperation({
  id: "orgs.runners.list",
  method: "GET",
  path: "/orgs/{org}/actions/runners",
  summary: "List an organization's self-hosted runners",
  description:
    "Lists the organization's self-hosted runners, oldest first, deleted ones too unless `status` says otherwise; never their credentials. Owners only.",
  input: z.object({
    org: Org,
    status: z
      .enum(["all", "serving", "revoked"])
      .default("all")
      .describe(
        "`serving`: neither revoked nor an ephemeral runner past its end. It says nothing of whether the runner is connected.",
      ),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    runners: z.array(SelfHostedRunner),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "self_hosted_runners:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_org_runners",
    title: "List self-hosted runners",
    description: "List an organization's self-hosted runners (never their credentials).",
    readOnly: true,
  },
});

export const SelfHostedRunnerDetail = SelfHostedRunner.extend({
  repositories: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        full_name: z.string(),
        visibility: z.enum(["public", "internal", "private"]),
      }),
    )
    .describe(
      "The repositories it lists, by name (none unless `repository_access` is `selected`).",
    ),
});

export const getRunner = defineOperation({
  id: "orgs.runners.get",
  method: "GET",
  path: "/orgs/{org}/actions/runners/{runner_id}",
  summary: "Get a self-hosted runner",
  description:
    "One runner of the organization, with the repositories it lists; never its credential. 404 `runner_not_found`. Owners only.",
  input: z.object({ org: Org, runner_id: RunnerId }),
  output: SelfHostedRunnerDetail,
  permission: "self_hosted_runners:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_org_runner",
    title: "Get a self-hosted runner",
    description:
      "Get one of an organization's self-hosted runners and the repositories it lists (never its credential).",
    readOnly: true,
  },
});

const CHANGE_NOTE =
  " 404 `runner_not_found`; 409 `runner_revoked` for a runner that no longer serves; 422 `unknown_repository` for an id that is not an active repository of the organization. Audited. Owners only.";

export const updateRunnerAccess = defineOperation({
  id: "orgs.runners.access.update",
  method: "PATCH",
  path: "/orgs/{org}/actions/runners/{runner_id}/access",
  summary: "Change which jobs a self-hosted runner may be given",
  description: `Changes the fields given and keeps the rest. \`selected_repository_ids\` replaces the list of a runner that is, or becomes, \`selected\` (409 \`access_not_selected\` otherwise); \`all\` empties it. The next claim, or offer of a job again, is decided by the new access; an assignment that already passed that check, or a job the runner has, goes on (to end it, force-cancel its run and see that it stopped, or stop the machine). After a widening, a job that waited because no runner could take it may take up to five minutes to be offered. 422 \`forks_need_ephemeral\` for \`allows_forks\` on a runner that is not ephemeral; 422 \`invalid_input\` with nothing to change.${CHANGE_NOTE}`,
  input: z.object({
    org: Org,
    runner_id: RunnerId,
    repository_access: RepositoryAccess.optional(),
    selected_repository_ids: SelectedIds.optional(),
    allows_public: AllowsPublic.optional(),
    allows_forks: AllowsForks.optional(),
  }),
  output: SelfHostedRunnerDetail,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_org_runner_access",
    title: "Change a self-hosted runner's access",
    description:
      "Change which repositories' jobs an organization's self-hosted runner may be given, and whether it takes public repositories' and fork pull requests' jobs. Widening lets less trusted code run on the runner's machine.",
    readOnly: false,
  },
});

const RunnerRepository = z.object({
  org: Org,
  runner_id: RunnerId,
  repository_id: RepositoryId,
});

export const addRunnerRepo = defineOperation({
  id: "orgs.runners.repositories.add",
  method: "PUT",
  path: "/orgs/{org}/actions/runners/{runner_id}/repositories/{repository_id}",
  summary: "Add a repository to a selected self-hosted runner",
  description: `Adds a repository to the list of a runner whose \`repository_access\` is \`selected\` (409 \`access_not_selected\` otherwise). 422 \`too_many_repositories\` past ${MAX_RUNNER_REPOS}. Adding one it lists changes nothing.${CHANGE_NOTE}`,
  input: RunnerRepository,
  output: NoContent,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: {
    tool: "add_org_runner_repo",
    title: "Add a repository to a self-hosted runner",
    description:
      "Let an organization's self-hosted runner that is limited to selected repositories take one more repository's jobs.",
    readOnly: false,
  },
});

export const removeRunnerRepo = defineOperation({
  id: "orgs.runners.repositories.remove",
  method: "DELETE",
  path: "/orgs/{org}/actions/runners/{runner_id}/repositories/{repository_id}",
  summary: "Remove a repository from a selected self-hosted runner",
  description:
    "Takes a repository out of the list of a runner whose `repository_access` is `selected` (409 `access_not_selected` otherwise), from its next job on. Removing one it does not list changes nothing. 404 `runner_not_found`; 409 `runner_revoked` for a runner that no longer serves. Audited. Owners only.",
  input: RunnerRepository,
  output: NoContent,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: {
    tool: "remove_org_runner_repo",
    title: "Remove a repository from a self-hosted runner",
    description:
      "Stop an organization's self-hosted runner that is limited to selected repositories taking a repository's jobs.",
    readOnly: false,
  },
});

export const deleteRunner = defineOperation({
  id: "orgs.runners.delete",
  method: "DELETE",
  path: "/orgs/{org}/actions/runners/{runner_id}",
  summary: "Delete a self-hosted runner",
  description:
    "Revokes a runner's credential at once: its next call is refused, and an idle runner stops. A job it is running goes on on its machine: to end it, force-cancel its run and see that it has stopped before deleting the runner, or stop the machine. It stays listed, with `revoked_at`, its access cleared. Deleting it again changes nothing. Audited. Owners only.",
  input: z.object({ org: Org, runner_id: RunnerId }),
  output: NoContent,
  permission: "self_hosted_runners:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: {
    tool: "delete_org_runner",
    title: "Delete a self-hosted runner",
    description:
      "Revoke an organization's self-hosted runner: its next call is refused. A job it is running goes on: force-cancel its run and see that it stopped first, or stop the machine.",
    readOnly: false,
  },
});
