import { type WranglerRunner, wrangler } from "./wrangler.ts";

/*
 * A Worker's live versions and their plain-text variables, read with
 * wrangler's `deployments status --json` and `versions view --json`. The JSON
 * shapes are read from wrangler's source; not yet run against a live account.
 */

/** A version serving some of the Worker's traffic. */
export interface LiveVersion {
  readonly version_id: string;
  readonly percentage: number;
}

/** The versions serving the Worker's traffic; empty when it has no deployment. */
export async function liveVersions(
  runner: WranglerRunner,
  worker: string,
): Promise<readonly LiveVersion[]> {
  const status = JSON.parse(
    await wrangler(runner, ["deployments", "status", "--name", worker, "--json"]),
  ) as { versions?: LiveVersion[] };
  return status.versions ?? [];
}

/** A version's plain-text variables, by name. */
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
