// Post-deploy smoke test for a Fyrden deployment:
//   node tools/ci/src/smoke.ts <api-url> <web-url>
// Checks the API's deep health, its OpenAPI document, the web page that calls
// the API over the service binding, and the web health check through it.

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Something to look at that does not fail the deployment. */
  warning?: string;
}

/** What a passing check found: its detail, and a warning if any. */
export interface Passed {
  detail: string;
  warning?: string;
}

export interface Check {
  name: string;
  run: () => Promise<string | Passed>;
}

const REQUIRED_CHECKS = ["d1", "durableObject", "r2"] as const;

/**
 * The RPC version the deployed web page must show. Equal to API_RPC_VERSION
 * in @fyrden/api-contract (a test keeps them in step); this script runs under
 * plain Node, which cannot load the workspace's TypeScript packages.
 */
export const EXPECTED_RPC_VERSION = 1;

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/**
 * A health report passes only if every storage tier was checked and passed.
 * Late or failed effects (webhook deliveries, feed entries) only warn: the
 * API serves without them, and a deployment that was down a while catches up.
 */
function assertHealthy(body: unknown): Passed {
  const report = body as {
    ok?: unknown;
    checks?: Record<
      string,
      { ok?: unknown; ms?: unknown; overdueS?: unknown; failed?: unknown; error?: unknown }
    >;
  };
  const checks = report.checks ?? {};
  const problems = REQUIRED_CHECKS.filter((name) => {
    const check = checks[name];
    return check?.ok !== true || typeof check.ms !== "number" || check.ms < 0;
  });
  if (report.ok !== true || problems.length > 0)
    throw new Error(`failed or missing checks: ${problems.join(", ") || "ok=false"}`);
  const detail = REQUIRED_CHECKS.map((name) => `${name} ${checks[name]?.ms} ms`).join(", ");
  const effects = checks.effects;
  if (effects === undefined || effects.ok === true) return { detail };
  if (typeof effects.overdueS !== "number")
    return { detail, warning: `effects check failed: ${String(effects.error ?? "unknown")}` };
  const failed = effects.failed === true;
  const warnings = [
    ...(!failed || effects.overdueS > 0 ? [`effects overdue by ${effects.overdueS} s`] : []),
    ...(failed ? ["an effect failed for good lately"] : []),
  ];
  return { detail, warning: warnings.join("; ") };
}

export function apiChecks(apiUrl: string, fetcher: typeof fetch = fetch): Check[] {
  const api = (path: string) => new URL(path, apiUrl).href;
  return [
    {
      name: "api healthz",
      run: async () => assertHealthy(await (await expectOk(await fetcher(api("/healthz")))).json()),
    },
    {
      name: "api openapi",
      run: async () => {
        const doc = (await (await expectOk(await fetcher(api("/api/openapi.json")))).json()) as {
          openapi?: string;
        };
        if (!doc.openapi?.startsWith("3.1"))
          throw new Error(`unexpected openapi version ${doc.openapi}`);
        return `OpenAPI ${doc.openapi}`;
      },
    },
  ];
}

export function webChecks(webUrl: string, fetcher: typeof fetch = fetch): Check[] {
  const web = (path: string) => new URL(path, webUrl).href;
  return [
    {
      name: "web renders via the API service binding",
      run: async () => {
        const html = await (await expectOk(await fetcher(web("/")))).text();
        const version = /API RPC version (?:<!-- -->)?(\d+)</.exec(html)?.[1];
        if (version !== String(EXPECTED_RPC_VERSION)) {
          throw new Error(
            `page shows API RPC version ${version ?? "(none)"}, expected ${EXPECTED_RPC_VERSION}`,
          );
        }
        return `RPC version ${version}`;
      },
    },
    {
      name: "web healthz through the binding",
      run: async () => assertHealthy(await (await expectOk(await fetcher(web("/healthz")))).json()),
    },
  ];
}

export async function runSmoke(checks: Check[]): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const check of checks) {
    try {
      const passed = await check.run();
      results.push({
        name: check.name,
        ok: true,
        ...(typeof passed === "string" ? { detail: passed } : passed),
      });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

if (import.meta.main) {
  const [apiUrl, webUrl] = process.argv.slice(2);
  if (!apiUrl || !webUrl) {
    console.error("usage: smoke.ts <api-url> <web-url>");
    process.exit(2);
  }
  const results = await runSmoke([...apiChecks(apiUrl), ...webChecks(webUrl)]);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
    if (r.warning) console.log(`WARN ${r.name}: ${r.warning}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
