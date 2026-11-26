import {
  HANDLE_SHAPE,
  MAX_CI_VALUE_BYTES,
  MAX_HANDLE_LENGTH,
  MAX_SELECTED_REPOS,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN, INSTANCE_READ, NoContent } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

/*
 * GitHub's Actions secrets and variables REST API, for repositories and
 * organizations (verified: https://docs.github.com/en/rest/actions/secrets and
 * https://docs.github.com/en/rest/actions/variables). Fyrden's deviations are
 * named in each description: administrators only (GitHub lets Write manage
 * them), string repository ids, and a user's namespace has no
 * organization-level ones.
 */

const Handle = z.string().min(1).max(MAX_HANDLE_LENGTH).regex(HANDLE_SHAPE);
const RepoInput = {
  owner: Handle.describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const OrgInput = { org: Handle.describe("The organization's handle.") };

const NAME_RULE =
  "Letters, digits and `_`, not starting with a digit or `GITHUB_`; case is ignored, and names are stored and returned uppercase.";
const SecretName = z
  .string()
  .min(1)
  .max(255)
  .describe(`The secret's name. ${NAME_RULE} \`GITEA_TOKEN\` is refused (Fyrden).`);
const VariableName = z.string().min(1).max(255).describe(`The variable's name. ${NAME_RULE}`);
const RepositoryId = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "A repository's id (`rep_…`, from `GET /repos/{owner}/{repo}`). Fyrden's ids are strings, where GitHub's are numbers, so `gh secret set --repos` does not work: pass ids.",
  );
const Visibility = z
  .enum(["all", "private", "selected"])
  .describe(
    "Which of the organization's repositories it reaches: `all`, `private` (private and internal ones, as they are when a run reads it), or `selected` (those listed).",
  );
const SelectedIds = z.array(RepositoryId).max(MAX_SELECTED_REPOS);
const Time = z.string().describe("ISO 8601.");

// Past the most, a page is the most, as on GitHub (`gh variable list` asks for 100 of 30).
const page = (max: number, fallback: number) => ({
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .default(fallback)
    .transform((n) => Math.min(n, max))
    .describe(`Page size, at most ${max}; a larger one is read as ${max}.`),
  page: z.coerce.number().int().min(1).max(1_000).default(1).describe("The page, from 1."),
});

const ADMIN =
  "Repository administrators only (GitHub also lets Write; Fyrden does not). 409 `repo_transferring` while a transfer moves the repository.";
const OWNER =
  "Organization owners only. A user's namespace has none: its handle answers 404 `not_an_org`.";
const SEALING = `\`encrypted_value\` is the value (UTF-8, at most ${MAX_CI_VALUE_BYTES} bytes) in a libsodium sealed box (\`crypto_box_seal\`, as \`gh secret set\` makes it) for the public key \`key_id\` names, in base64. Refused with 422: \`bad_key_id\` (not a public key of this scope the server holds; get it again), \`undecryptable_value\` (the box does not open or is not UTF-8), \`secret_too_large\`, \`invalid_secret_name\`, \`too_many_secrets\`; 503 \`ci_key_unavailable\` while the server's CI key is missing or misconfigured. Answers 201 when it creates the secret, 204 when it updates it.`;
const REPO_FENCE =
  " 404 `repo_not_found` when the repository is no longer the account's when the write commits; 409 `repository_changed` when it left and came back meanwhile: send it again.";
const ORG_FENCE =
  " 409 `repository_changed` when a repository the write lists moved or was deleted between the lookup and the commit: send it again. A repository already moving to another owner when the write looks it up may instead answer 422 `unknown_repository`.";

const PublicKey = z.object({
  key_id: z.string().describe("Which key: pass it with `encrypted_value`."),
  key: z.string().describe("The X25519 public key, base64."),
});

const Secret = z.object({
  name: z.string(),
  created_at: Time,
  updated_at: Time,
  unreadable: z
    .boolean()
    .optional()
    .describe(
      "Fyrden: present (true) when the server can no longer open the secret (its master key is gone); set it again.",
    ),
});
const OrgSecret = Secret.extend({
  visibility: Visibility,
  selected_repositories_url: z
    .string()
    .optional()
    .describe("With visibility `selected`: where its repositories are listed."),
});
const Variable = z.object({
  name: z.string(),
  value: z.string(),
  created_at: Time,
  updated_at: Time,
});
const OrgVariable = Variable.extend({
  visibility: Visibility,
  selected_repositories_url: z
    .string()
    .optional()
    .describe("With visibility `selected`: where its repositories are listed."),
});
const SelectedRepositories = z.object({
  total_count: z.number().int(),
  repositories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      full_name: z.string(),
      visibility: z.enum(["public", "internal", "private"]),
    }),
  ),
});

const read = <T extends string>(tool: T, title: string, description: string) => ({
  tool,
  title,
  description,
  readOnly: true as const,
});
const write = <T extends string>(tool: T, title: string, description: string) => ({
  tool,
  title,
  description,
  readOnly: false as const,
});

export const getRepoSecretPublicKey = defineOperation({
  id: "repos.actions.secrets.public_key",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/secrets/public-key",
  summary: "Get a repository public key",
  description: `The public key to seal the repository's secret values for. Each repository has its own. ${ADMIN} 503 \`ci_key_unavailable\` while the server's CI key is missing or misconfigured.`,
  input: z.object(RepoInput),
  output: PublicKey,
  permission: "secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "get_repo_secret_public_key",
    "Get a repository's secrets public key",
    "Get the public key to seal a repository's Actions secret values for (libsodium sealed box).",
  ),
});

export const listRepoSecrets = defineOperation({
  id: "repos.actions.secrets.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/secrets",
  summary: "List repository secrets",
  description: `The repository's Actions secrets by name: names and times, never values. ${ADMIN}`,
  input: z.object({ ...RepoInput, ...page(100, 30) }),
  output: z.object({ total_count: z.number().int(), secrets: z.array(Secret) }),
  permission: "secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_repo_secrets",
    "List repository secrets",
    "List a repository's Actions secrets (names only, never values).",
  ),
});

export const getRepoSecret = defineOperation({
  id: "repos.actions.secrets.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/secrets/{secret_name}",
  summary: "Get a repository secret",
  description: `One secret's name and times, never its value. ${ADMIN}`,
  input: z.object({ ...RepoInput, secret_name: SecretName }),
  output: Secret,
  permission: "secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "get_repo_secret",
    "Get a repository secret",
    "Get an Actions secret of a repository (name and times, never the value).",
  ),
});

export const setRepoSecret = defineOperation({
  id: "repos.actions.secrets.set",
  method: "PUT",
  path: "/repos/{owner}/{repo}/actions/secrets/{secret_name}",
  summary: "Create or update a repository secret",
  description: `Sets a secret of the repository (100 at most). ${SEALING}${REPO_FENCE} ${ADMIN}`,
  input: z.object({
    ...RepoInput,
    secret_name: SecretName,
    encrypted_value: z.string().max(262_144),
    key_id: z.string().max(100),
  }),
  output: NoContent,
  successStatuses: [201, 204],
  permission: "secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "set_repo_secret",
    "Set a repository secret",
    "Create or update a repository's Actions secret. The value must be sealed (libsodium sealed box, base64) for the repository's public key, never sent as plain text.",
  ),
});

export const deleteRepoSecret = defineOperation({
  id: "repos.actions.secrets.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/actions/secrets/{secret_name}",
  summary: "Delete a repository secret",
  description: `Deletes a secret of the repository. ${ADMIN}`,
  input: z.object({ ...RepoInput, secret_name: SecretName }),
  output: NoContent,
  successStatus: 204,
  permission: "secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "delete_repo_secret",
    "Delete a repository secret",
    "Delete a repository's Actions secret.",
  ),
});

export const listRepoOrgSecrets = defineOperation({
  id: "repos.actions.organization_secrets.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/organization-secrets",
  summary: "List repository organization secrets",
  description: `The organization's secrets that reach the repository, by name: names and times, never values. A run takes the first 100 of them by name, under the repository's own of the same name. A user's repository has none. ${ADMIN}`,
  input: z.object({ ...RepoInput, ...page(100, 30) }),
  output: z.object({ total_count: z.number().int(), secrets: z.array(Secret) }),
  permission: "secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_repo_org_secrets",
    "List a repository's organization secrets",
    "List the organization Actions secrets that reach a repository (names only).",
  ),
});

export const getOrgSecretPublicKey = defineOperation({
  id: "orgs.actions.secrets.public_key",
  method: "GET",
  path: "/orgs/{org}/actions/secrets/public-key",
  summary: "Get an organization public key",
  description: `The public key to seal the organization's secret values for. ${OWNER} 503 \`ci_key_unavailable\` while the server's CI key is missing or misconfigured.`,
  input: z.object(OrgInput),
  output: PublicKey,
  permission: "organization_secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "get_org_secret_public_key",
    "Get an organization's secrets public key",
    "Get the public key to seal an organization's Actions secret values for (libsodium sealed box).",
  ),
});

export const listOrgSecrets = defineOperation({
  id: "orgs.actions.secrets.list",
  method: "GET",
  path: "/orgs/{org}/actions/secrets",
  summary: "List organization secrets",
  description: `The organization's Actions secrets by name: names, times and visibility, never values. ${OWNER}`,
  input: z.object({ ...OrgInput, ...page(100, 30) }),
  output: z.object({ total_count: z.number().int(), secrets: z.array(OrgSecret) }),
  permission: "organization_secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_org_secrets",
    "List organization secrets",
    "List an organization's Actions secrets (names and visibility, never values).",
  ),
});

export const getOrgSecret = defineOperation({
  id: "orgs.actions.secrets.get",
  method: "GET",
  path: "/orgs/{org}/actions/secrets/{secret_name}",
  summary: "Get an organization secret",
  description: `One secret's name, times and visibility, never its value. ${OWNER}`,
  input: z.object({ ...OrgInput, secret_name: SecretName }),
  output: OrgSecret,
  permission: "organization_secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "get_org_secret",
    "Get an organization secret",
    "Get an organization's Actions secret (name, times and visibility, never the value).",
  ),
});

export const setOrgSecret = defineOperation({
  id: "orgs.actions.secrets.set",
  method: "PUT",
  path: "/orgs/{org}/actions/secrets/{secret_name}",
  summary: "Create or update an organization secret",
  description: `Sets a secret of the organization (1,000 at most) and which repositories it reaches. With visibility \`selected\`, \`selected_repository_ids\` replaces its list (absent: kept); another visibility empties it. An id that is not a repository of the organization is refused with 422 \`unknown_repository\`. ${SEALING}${ORG_FENCE} ${OWNER}`,
  input: z.object({
    ...OrgInput,
    secret_name: SecretName,
    encrypted_value: z.string().max(262_144),
    key_id: z.string().max(100),
    visibility: Visibility,
    selected_repository_ids: SelectedIds.optional(),
  }),
  output: NoContent,
  successStatuses: [201, 204],
  permission: "organization_secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "set_org_secret",
    "Set an organization secret",
    "Create or update an organization's Actions secret and choose the repositories it reaches. The value must be sealed (libsodium sealed box, base64) for the organization's public key, never sent as plain text.",
  ),
});

export const deleteOrgSecret = defineOperation({
  id: "orgs.actions.secrets.delete",
  method: "DELETE",
  path: "/orgs/{org}/actions/secrets/{secret_name}",
  summary: "Delete an organization secret",
  description: `Deletes a secret of the organization. ${OWNER}`,
  input: z.object({ ...OrgInput, secret_name: SecretName }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "delete_org_secret",
    "Delete an organization secret",
    "Delete an organization's Actions secret.",
  ),
});

const NOT_SELECTED = "Only for visibility `selected`: otherwise 409 `visibility_not_selected`.";

export const listOrgSecretRepos = defineOperation({
  id: "orgs.actions.secrets.repos.list",
  method: "GET",
  path: "/orgs/{org}/actions/secrets/{secret_name}/repositories",
  summary: "List selected repositories for an organization secret",
  description: `The repositories an organization secret lists. ${NOT_SELECTED} ${OWNER}`,
  input: z.object({ ...OrgInput, secret_name: SecretName, ...page(100, 30) }),
  output: SelectedRepositories,
  permission: "organization_secrets:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_org_secret_repos",
    "List an organization secret's repositories",
    "List the repositories an organization Actions secret with visibility selected reaches.",
  ),
});

export const setOrgSecretRepos = defineOperation({
  id: "orgs.actions.secrets.repos.set",
  method: "PUT",
  path: "/orgs/{org}/actions/secrets/{secret_name}/repositories",
  summary: "Set selected repositories for an organization secret",
  description: `Replaces the repositories an organization secret lists. ${NOT_SELECTED} 422 \`unknown_repository\` for an id that is not a repository of the organization.${ORG_FENCE} ${OWNER}`,
  input: z.object({ ...OrgInput, secret_name: SecretName, selected_repository_ids: SelectedIds }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "set_org_secret_repos",
    "Set an organization secret's repositories",
    "Replace the repositories an organization Actions secret with visibility selected reaches.",
  ),
});

export const addOrgSecretRepo = defineOperation({
  id: "orgs.actions.secrets.repos.add",
  method: "PUT",
  path: "/orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}",
  summary: "Add selected repository to an organization secret",
  description: `Adds a repository to an organization secret's list. ${NOT_SELECTED} 422 \`unknown_repository\` for an id that is not a repository of the organization. 422 \`too_many_repositories\` past ${MAX_SELECTED_REPOS} listed.${ORG_FENCE} ${OWNER}`,
  input: z.object({ ...OrgInput, secret_name: SecretName, repository_id: RepositoryId }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "add_org_secret_repo",
    "Add a repository to an organization secret",
    "Let one more repository use an organization Actions secret with visibility selected.",
  ),
});

export const removeOrgSecretRepo = defineOperation({
  id: "orgs.actions.secrets.repos.remove",
  method: "DELETE",
  path: "/orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}",
  summary: "Remove selected repository from an organization secret",
  description: `Removes a repository from an organization secret's list. ${NOT_SELECTED} ${OWNER}`,
  input: z.object({ ...OrgInput, secret_name: SecretName, repository_id: RepositoryId }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_secrets:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "remove_org_secret_repo",
    "Remove a repository from an organization secret",
    "Stop a repository using an organization Actions secret with visibility selected.",
  ),
});

const VALUE_RULE = `At most ${MAX_CI_VALUE_BYTES} bytes of UTF-8 (422 \`variable_too_large\`).`;
const VariableValue = z
  .string()
  .max(4 * MAX_CI_VALUE_BYTES)
  .describe(`The value. ${VALUE_RULE}`);

export const listRepoVariables = defineOperation({
  id: "repos.actions.variables.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/variables",
  summary: "List repository variables",
  description: `The repository's Actions variables by name, with their values. ${ADMIN}`,
  input: z.object({ ...RepoInput, ...page(30, 10) }),
  output: z.object({ total_count: z.number().int(), variables: z.array(Variable) }),
  permission: "variables:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_repo_variables",
    "List repository variables",
    "List a repository's Actions variables.",
  ),
});

export const createRepoVariable = defineOperation({
  id: "repos.actions.variables.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/variables",
  summary: "Create a repository variable",
  description: `Creates a variable of the repository (500 at most; 422 \`too_many_variables\`); 409 \`variable_exists\` when it has one of the name (update it instead), 422 \`invalid_variable_name\`.${REPO_FENCE} ${ADMIN}`,
  input: z.object({ ...RepoInput, name: VariableName, value: VariableValue }),
  output: NoContent,
  successStatus: 201,
  permission: "variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "create_repo_variable",
    "Create a repository variable",
    "Create a repository's Actions variable.",
  ),
});

export const getRepoVariable = defineOperation({
  id: "repos.actions.variables.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/variables/{name}",
  summary: "Get a repository variable",
  description: `One variable, with its value. ${ADMIN}`,
  input: z.object({ ...RepoInput, name: VariableName }),
  output: Variable,
  permission: "variables:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "get_repo_variable",
    "Get a repository variable",
    "Get a repository's Actions variable.",
  ),
});

export const updateRepoVariable = defineOperation({
  id: "repos.actions.variables.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/actions/variables/{name}",
  summary: "Update a repository variable",
  description: `Changes a variable's value. A variable is not renamed: a body \`name\` other than the path's (ignoring case) answers 422 \`invalid_input\`, where GitHub renames.${REPO_FENCE} ${ADMIN}`,
  input: z.object({
    ...RepoInput,
    name: VariableName,
    value: VariableValue.optional(),
  }),
  output: NoContent,
  successStatus: 204,
  permission: "variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "update_repo_variable",
    "Update a repository variable",
    "Change a repository's Actions variable.",
  ),
});

export const deleteRepoVariable = defineOperation({
  id: "repos.actions.variables.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/actions/variables/{name}",
  summary: "Delete a repository variable",
  description: `Deletes a variable of the repository. ${ADMIN}`,
  input: z.object({ ...RepoInput, name: VariableName }),
  output: NoContent,
  successStatus: 204,
  permission: "variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "delete_repo_variable",
    "Delete a repository variable",
    "Delete a repository's Actions variable.",
  ),
});

export const listRepoOrgVariables = defineOperation({
  id: "repos.actions.organization_variables.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/organization-variables",
  summary: "List repository organization variables",
  description: `The organization's variables that reach the repository, by name, with their values. A user's repository has none. ${ADMIN}`,
  input: z.object({ ...RepoInput, ...page(30, 10) }),
  output: z.object({ total_count: z.number().int(), variables: z.array(Variable) }),
  permission: "variables:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_repo_org_variables",
    "List a repository's organization variables",
    "List the organization Actions variables that reach a repository.",
  ),
});

export const listOrgVariables = defineOperation({
  id: "orgs.actions.variables.list",
  method: "GET",
  path: "/orgs/{org}/actions/variables",
  summary: "List organization variables",
  description: `The organization's Actions variables by name, with their values and visibility. ${OWNER}`,
  input: z.object({ ...OrgInput, ...page(30, 10) }),
  output: z.object({ total_count: z.number().int(), variables: z.array(OrgVariable) }),
  permission: "organization_variables:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_org_variables",
    "List organization variables",
    "List an organization's Actions variables.",
  ),
});

export const createOrgVariable = defineOperation({
  id: "orgs.actions.variables.create",
  method: "POST",
  path: "/orgs/{org}/actions/variables",
  summary: "Create an organization variable",
  description: `Creates a variable of the organization (1,000 at most; 422 \`too_many_variables\`) and chooses the repositories it reaches (\`selected_repository_ids\` with visibility \`selected\`; 422 \`unknown_repository\` for an id that is not a repository of the organization); 409 \`variable_exists\` when it has one of the name, 422 \`invalid_variable_name\`.${ORG_FENCE} ${OWNER}`,
  input: z.object({
    ...OrgInput,
    name: VariableName,
    value: VariableValue,
    visibility: Visibility,
    selected_repository_ids: SelectedIds.optional(),
  }),
  output: NoContent,
  successStatus: 201,
  permission: "organization_variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "create_org_variable",
    "Create an organization variable",
    "Create an organization's Actions variable and choose the repositories it reaches.",
  ),
});

export const getOrgVariable = defineOperation({
  id: "orgs.actions.variables.get",
  method: "GET",
  path: "/orgs/{org}/actions/variables/{name}",
  summary: "Get an organization variable",
  description: `One variable, with its value and visibility. ${OWNER}`,
  input: z.object({ ...OrgInput, name: VariableName }),
  output: OrgVariable,
  permission: "organization_variables:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "get_org_variable",
    "Get an organization variable",
    "Get an organization's Actions variable.",
  ),
});

export const updateOrgVariable = defineOperation({
  id: "orgs.actions.variables.update",
  method: "PATCH",
  path: "/orgs/{org}/actions/variables/{name}",
  summary: "Update an organization variable",
  description: `Changes a variable's value or the repositories it reaches (a new visibility; with \`selected\`, \`selected_repository_ids\` replaces the list, absent: kept; \`selected_repository_ids\` alone replaces the list of a variable already \`selected\`, and answers 409 \`visibility_not_selected\` for any other). A variable is not renamed: a body \`name\` other than the path's (ignoring case) answers 422 \`invalid_input\`, where GitHub renames.${ORG_FENCE} ${OWNER}`,
  input: z.object({
    ...OrgInput,
    name: VariableName,
    value: VariableValue.optional(),
    visibility: Visibility.optional(),
    selected_repository_ids: SelectedIds.optional(),
  }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "update_org_variable",
    "Update an organization variable",
    "Change an organization's Actions variable or the repositories it reaches.",
  ),
});

export const deleteOrgVariable = defineOperation({
  id: "orgs.actions.variables.delete",
  method: "DELETE",
  path: "/orgs/{org}/actions/variables/{name}",
  summary: "Delete an organization variable",
  description: `Deletes a variable of the organization. ${OWNER}`,
  input: z.object({ ...OrgInput, name: VariableName }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "delete_org_variable",
    "Delete an organization variable",
    "Delete an organization's Actions variable.",
  ),
});

export const listOrgVariableRepos = defineOperation({
  id: "orgs.actions.variables.repos.list",
  method: "GET",
  path: "/orgs/{org}/actions/variables/{name}/repositories",
  summary: "List selected repositories for an organization variable",
  description: `The repositories an organization variable lists. ${NOT_SELECTED} ${OWNER}`,
  input: z.object({ ...OrgInput, name: VariableName, ...page(100, 30) }),
  output: SelectedRepositories,
  permission: "organization_variables:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: read(
    "list_org_variable_repos",
    "List an organization variable's repositories",
    "List the repositories an organization Actions variable with visibility selected reaches.",
  ),
});

export const setOrgVariableRepos = defineOperation({
  id: "orgs.actions.variables.repos.set",
  method: "PUT",
  path: "/orgs/{org}/actions/variables/{name}/repositories",
  summary: "Set selected repositories for an organization variable",
  description: `Replaces the repositories an organization variable lists. ${NOT_SELECTED} 422 \`unknown_repository\` for an id that is not a repository of the organization.${ORG_FENCE} ${OWNER}`,
  input: z.object({ ...OrgInput, name: VariableName, selected_repository_ids: SelectedIds }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "set_org_variable_repos",
    "Set an organization variable's repositories",
    "Replace the repositories an organization Actions variable with visibility selected reaches.",
  ),
});

export const addOrgVariableRepo = defineOperation({
  id: "orgs.actions.variables.repos.add",
  method: "PUT",
  path: "/orgs/{org}/actions/variables/{name}/repositories/{repository_id}",
  summary: "Add selected repository to an organization variable",
  description: `Adds a repository to an organization variable's list. ${NOT_SELECTED} 422 \`unknown_repository\` for an id that is not a repository of the organization. 422 \`too_many_repositories\` past ${MAX_SELECTED_REPOS} listed.${ORG_FENCE} ${OWNER}`,
  input: z.object({ ...OrgInput, name: VariableName, repository_id: RepositoryId }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "add_org_variable_repo",
    "Add a repository to an organization variable",
    "Let one more repository use an organization Actions variable with visibility selected.",
  ),
});

export const removeOrgVariableRepo = defineOperation({
  id: "orgs.actions.variables.repos.remove",
  method: "DELETE",
  path: "/orgs/{org}/actions/variables/{name}/repositories/{repository_id}",
  summary: "Remove selected repository from an organization variable",
  description: `Removes a repository from an organization variable's list. ${NOT_SELECTED} ${OWNER}`,
  input: z.object({ ...OrgInput, name: VariableName, repository_id: RepositoryId }),
  output: NoContent,
  successStatus: 204,
  permission: "organization_variables:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: write(
    "remove_org_variable_repo",
    "Remove a repository from an organization variable",
    "Stop a repository using an organization Actions variable with visibility selected.",
  ),
});

export const rewrapCiSecrets = defineOperation({
  id: "admin.ci.secrets.rewrap",
  method: "POST",
  path: "/admin/ci/secrets/rewrap",
  summary: "Wrap CI data keys with the current key",
  description:
    "Fyrden: wraps again, with the current CI master key (`CI_SECRETS_KEY_NEXT` while a rotation is under way, else `CI_SECRETS_KEY`), every account's data keys wrapped with another, a batch of accounts at a time (call again with `cursor` until `next_cursor` is null). Secrets are not encrypted again. `remaining` counts data keys still under another key that open, `unreadable` those whose master key is gone, both for this call's accounts only: add them up over a whole sweep, and sweep again until the sum of `remaining` is 0. 503 `ci_key_unavailable` while the key is missing or misconfigured. Instance administrators only.",
  input: z.object({ cursor: z.string().max(200).optional() }),
  output: z.object({
    rewrapped: z.number().int(),
    remaining: z.number().int(),
    unreadable: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});

const AccountHandle = Handle.describe("The user's or organization's handle.");
const Generation = z
  .number()
  .int()
  .min(1)
  .max(999_999_999)
  .describe("A data key generation (the number before the dot in a public key's `key_id`).");

export const getCiDataKey = defineOperation({
  id: "admin.ci.data_key.get",
  method: "GET",
  path: "/admin/accounts/{account}/ci/data-key",
  summary: "Get an account's CI data key status",
  description:
    "Fyrden: the account's id and newest CI data key generation (null before any secret was set), how many Actions secrets it holds, and how many of them do not open (their generation was replaced, or its master key is gone). `unreadable` lists the first 100 of those by scope (`org` or a repository id) and name; `unreadable_truncated` is true when there are more. Never a value or a key. A suspended account is found. Instance administrators only.",
  input: z.object({ account: AccountHandle }),
  output: z.object({
    account_id: z.string(),
    generation: z.number().int().nullable(),
    created_at: z.string().nullable(),
    secrets: z.number().int(),
    unreadable_secrets: z.number().int(),
    unreadable: z.array(z.object({ scope: z.string(), name: z.string() })),
    unreadable_truncated: z.boolean(),
  }),
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const replaceCiDataKey = defineOperation({
  id: "admin.ci.data_key.replace",
  method: "POST",
  path: "/admin/accounts/{account}/ci/data-key/replace",
  summary: "Replace an account's CI data key",
  description:
    "Fyrden: for a leaked account data key. Starts a new data key generation for the account and retires `generation` and every older one: their wrapped keys are erased, so their secrets stay listed with `unreadable: true` and are never delivered to a job until set again under the new public key. Variables are not touched. Cannot be undone. `account_id` and `generation` come from `GET /admin/accounts/{account}/ci/data-key`: 409 `account_changed` when the handle is now another account's, 409 `no_data_key` when the account has no such generation, 409 `generation_changed` when `generation` is not the newest. Naming a generation already replaced answers that replacement again and changes nothing, so a retry (with or without an `Idempotency-Key`) answers the same. 503 `ci_key_unavailable` while the CI master key is missing or misconfigured. A suspended account is found. Instance administrators only.",
  input: z.object({
    account: AccountHandle,
    account_id: z.string().min(1).max(64).describe("The account's id, as the status answers it."),
    generation: Generation.describe("The generation to replace: the account's newest."),
  }),
  output: z.object({
    account_id: z.string(),
    generation: z.number().int(),
    replaced_generation: z.number().int(),
    replaced_at: z.string(),
  }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});
