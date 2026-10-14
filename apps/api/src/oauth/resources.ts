/**
 * The protected resources this deployment serves (RFC 8707 resource
 * indicators, RFC 9728 metadata): the REST API (with its raw files,
 * archives and chunked upload parts) and the MCP server. An access token
 * the authorization server issues names one of them as its audience and is
 * accepted only there; other tokens (personal access, git) have none.
 */
export const RESOURCES = ["api", "mcp"] as const;
export type Resource = (typeof RESOURCES)[number];

/** A resource's identifier: its URL on this deployment's origin. */
export const resourceUri = (origin: string, resource: Resource): string => `${origin}/${resource}`;

/** The resource `uri` names on this origin, if any. */
export function resourceOf(origin: string, uri: string): Resource | undefined {
  return RESOURCES.find((r) => resourceUri(origin, r) === uri);
}

/** Where a resource's RFC 9728 metadata is. */
export const resourceMetadataUri = (origin: string, resource: Resource): string =>
  `${origin}/.well-known/oauth-protected-resource/${resource}`;

/** Whether a token for `audience` (null: any of this deployment's) may be used at `resource`. */
export const audienceAllows = (audience: string | null, origin: string, resource: Resource) =>
  audience === null || audience === resourceUri(origin, resource);

/** The `WWW-Authenticate` challenge of a 401 at `resource`, pointing clients at its metadata. */
export function bearerChallenge(origin: string, resource: Resource, error?: string): string {
  const parts = [
    'Bearer realm="fyrden"',
    `resource_metadata="${resourceMetadataUri(origin, resource)}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}
