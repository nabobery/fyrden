import { type WranglerRunner, wrangler } from "./wrangler.ts";

/*
 * The JSON shapes of wrangler's `deployments status --json` and `versions view
 * --json` are read from its source; unverified against a live account.
 */

export interface LiveVersion {
  readonly version_id: string;
  readonly percentage: number;
}

/** Empty when the Worker has no deployment. */
export async function liveVersions(
  runner: WranglerRunner,
  worker: string,
): Promise<readonly LiveVersion[]> {
  const status = JSON.parse(
    await wrangler(runner, ["deployments", "status", "--name", worker, "--json"]),
  ) as { versions?: LiveVersion[] };
  return status.versions ?? [];
}

/** Plain-text variables only. */
export async function versionVars(
  runner: WranglerRunner,
  worker: string,
  versionId: string,
): Promise<Record<string, string>> {
  const version = JSON.parse(
    await wrangler(runner, ["versions", "view", versionId, "--name", worker, "--json"]),
  ) as { resources: { bindings: { type: string; name: string; text?: string }[] } };
  return Object.fromEntries(
    version.resources.bindings
      .filter((b) => b.type === "plain_text" && b.text !== undefined)
      .map((b) => [b.name, b.text as string]),
  );
}
