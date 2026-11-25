import { parseWorkflow } from "@fyrden/domain/ci";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  byoProvider,
  type CostEstimate,
  type JobRequirements,
  type ProviderCapabilities,
  type RunnerProvider,
  requiresJobNetwork,
  schedule,
} from "../src/index.js";
import { createFakeProvider, type FakeProviderOptions } from "../testing/index.js";
import { job } from "./helpers/jobs.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const price = (microUsdPerMinute: number, billingStepMs = MINUTE, expectedBootMs = 0) => ({
  microUsdPerMinute,
  billingStepMs,
  expectedBootMs,
});

const fake = (id: string, options: FakeProviderOptions = {}) =>
  createFakeProvider({ id, ...options }).provider;

/** A provider that estimates every job, so the scheduler's own guards decide. */
const willing = (
  id: string,
  capabilities: Partial<ProviderCapabilities> = {},
  estimate: CostEstimate = price(10),
): RunnerProvider => ({ ...fake(id, { capabilities }), estimate: () => estimate });

const chosen = (req: JobRequirements, candidates: readonly RunnerProvider[]) =>
  schedule(req, candidates).choice?.provider.id ?? null;

const reason = (req: JobRequirements, candidate: RunnerProvider) => {
  const { choice, dropped } = schedule(req, [candidate]);
  expect(choice).toBeNull();
  return dropped;
};

describe("what a candidate is dropped for", () => {
  it.each([
    ["does_not_provision", job(), { provisions: false }],
    ["os", job({ os: "windows" }), {}],
    ["arch", job({ arch: "arm64" }), {}],
    ["docker", job({ docker: true }), { docker: false, containerNetworking: "host" }],
    ["docker", job({ docker: true }), { docker: "unknown", containerNetworking: "host" }],
    ["docker", job({ jobNetwork: true }), { docker: "unknown", containerNetworking: "per_job" }],
    ["networking", job({ jobNetwork: true }), { containerNetworking: "host" }],
    ["networking", job({ jobNetwork: true }), { containerNetworking: "unknown" }],
    ["lifetime", job({ timeoutMs: HOUR + 1 }), { maxLifetimeMs: HOUR }],
    ["lifetime", job(), { maxLifetimeMs: Number.NaN }],
  ] as const)("%s", (why, req, capabilities) => {
    expect(reason(req, willing("p", capabilities))).toEqual([{ providerId: "p", reason: why }]);
  });

  it("what the provider itself cannot run, in its words: labels among them", () => {
    for (const labels of [["gpu"], [], ["ubuntu-latest", "gpu"]])
      expect(reason(job({ labels }), fake("p"))).toEqual([
        { providerId: "p", reason: "unsupported", detail: "labels" },
      ]);
    expect(chosen(job({ labels: ["Ubuntu-Latest"] }), [fake("p")])).toBe("p");
  });

  it.each([
    price(-1),
    price(Number.NaN),
    price(0.5),
    price(1, 0),
    price(1, 1.5),
    price(1, MINUTE, -1),
    price(1, MINUTE, Number.POSITIVE_INFINITY),
    // Its cost would not be a whole number JavaScript keeps exactly.
    price(Number.MAX_SAFE_INTEGER),
  ])("an estimate that is not whole and priced: %j", (estimate) => {
    expect(reason(job(), willing("p", {}, estimate))).toEqual([
      { providerId: "p", reason: "invalid_estimate" },
    ]);
  });

  it("a lifetime that its boot and the job together pass", () => {
    const boots = (expectedBootMs: number) =>
      willing("p", { maxLifetimeMs: HOUR }, price(10, MINUTE, expectedBootMs));
    expect(reason(job({ timeoutMs: HOUR - 1 }), boots(2))).toEqual([
      { providerId: "p", reason: "lifetime" },
    ]);
    expect(chosen(job({ timeoutMs: HOUR - 1 }), [boots(1)])).toBe("p");
  });

  it("nothing: a job that runs to the lifetime, and any os or arch", () => {
    expect(chosen(job({ timeoutMs: HOUR }), [willing("p", { maxLifetimeMs: HOUR })])).toBe("p");
    expect(chosen(job({ timeoutMs: 9 * HOUR }), [willing("p", { maxLifetimeMs: null })])).toBe("p");
    expect(chosen(job({ os: null, arch: null }), [willing("p", { os: [], arch: [] })])).toBe("p");
  });

  it("each with its own reason, in the candidates' order", () => {
    const { choice, dropped } = schedule(job({ jobNetwork: true }), [
      byoProvider,
      willing("hostnet", { containerNetworking: "host" }),
      willing("good"),
      fake("labels", { labels: ["other"] }),
    ]);
    expect(choice?.provider.id).toBe("good");
    expect(dropped).toEqual([
      { providerId: "byo", reason: "does_not_provision" },
      { providerId: "hostnet", reason: "networking" },
      { providerId: "labels", reason: "unsupported", detail: "labels" },
    ]);
  });

  it("is not decided between two of one id, which nothing could tell apart", () => {
    const twins = [willing("p", {}, price(1)), willing("p", {}, price(1))];
    expect(() => schedule(job(), twins)).toThrow(RangeError);
    // Dropped or not.
    expect(() => schedule(job(), [willing("p"), willing("p", { provisions: false })])).toThrow(
      /two candidates are p/,
    );
  });

  it("is not decided around a candidate that throws: describe and estimate call nothing, so it is a bug", () => {
    const broken: RunnerProvider = {
      ...willing("broken"),
      estimate: () => {
        throw new Error("a bug");
      },
    };
    expect(() => schedule(job(), [willing("good"), broken])).toThrow("a bug");
  });

  it("everything, with no candidates", () => {
    expect(schedule(job(), [])).toEqual({ choice: null, dropped: [] });
  });
});

describe("which candidate is cheapest", () => {
  it("counts whole billing steps of the expected time, not the price a minute", () => {
    const hourly = willing("hourly", {}, price(10, HOUR));
    const byMinute = willing("by-minute", {}, price(50));
    // 10 minutes: 600 for the hour, 500 by the minute. 50 minutes: 600 against 2,500.
    expect(chosen(job({ expectedMs: 10 * MINUTE }), [hourly, byMinute])).toBe("by-minute");
    expect(chosen(job({ expectedMs: 50 * MINUTE }), [hourly, byMinute])).toBe("hourly");
  });

  it("answers the expected cost in whole micro-USD, rounded up", () => {
    const cost = (expectedMs: number, estimate: CostEstimate) =>
      schedule(job({ expectedMs }), [willing("p", {}, estimate)]).choice?.costMicroUsd;
    expect(cost(10 * MINUTE, price(50))).toBe(500);
    expect(cost(10 * MINUTE + 1, price(50))).toBe(550);
    expect(cost(1, price(1, 1))).toBe(1);
    expect(cost(MINUTE, price(0))).toBe(0);
  });

  it("is decided before rounding, so a cheaper one that rounds the same still wins", () => {
    // 1/60 and 2/60 of a micro-USD, both 1 rounded up.
    const a = willing("a", {}, price(2, 1));
    const b = willing("b", {}, price(1, 1));
    expect(chosen(job({ expectedMs: 1_000 }), [a, b])).toBe("b");
  });

  it("boots sooner on a tie, then comes first by id", () => {
    const slow = willing("a", {}, price(10, MINUTE, 2));
    const fast = willing("b", {}, price(10, MINUTE, 1));
    expect(chosen(job(), [slow, fast])).toBe("b");
    const [x, y] = [willing("x"), willing("y")];
    expect(chosen(job(), [y, x])).toBe("x");
  });
});

describe("the job asked about", () => {
  it.each([{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { expectedMs: -1 }, { expectedMs: Number.NaN }])(
    "has whole, positive times: %j",
    (times) => {
      expect(() => schedule(job(times), [willing("p")])).toThrow(RangeError);
    },
  );

  it("needs a network of its own for services or a container, whatever its labels", () => {
    const needs = (lines: string) => {
      const parsed = parseWorkflow(
        "w.yml",
        new TextEncoder().encode(
          `on: push\njobs:\n  a:\n    runs-on: host\n${lines}    steps:\n      - run: "true"\n`,
        ),
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const [first] = parsed.workflow.jobs;
      if (!first) throw new Error("no job");
      return requiresJobNetwork(first);
    };
    expect(needs("")).toBe(false);
    expect(needs("    services:\n      db:\n        image: postgres\n")).toBe(true);
    expect(needs("    container: node:24\n")).toBe(true);
  });
});

/*
 * Small domains, so ties and unknowns come up often. The oracle below says
 * what is eligible and what it costs in its own words: it uses nothing of
 * the scheduler's.
 */
const OS = ["linux", "macos"] as const;
const ARCH = ["amd64", "arm64"] as const;

const aPrice = {
  microUsdPerMinute: fc.nat({ max: 2 }),
  billingStepMs: fc.constantFrom(1, 2, 3),
  expectedBootMs: fc.nat({ max: 1 }),
};
const anyCandidate = fc.record({
  provisions: fc.boolean(),
  os: fc.subarray([...OS]),
  arch: fc.subarray([...ARCH]),
  docker: fc.constantFrom(true, false, "unknown" as const),
  containerNetworking: fc.constantFrom("per_job" as const, "host" as const, "unknown" as const),
  maxLifetimeMs: fc.constantFrom(null, 1, 2),
  knowsLabels: fc.boolean(),
  ...aPrice,
});
type Candidate = typeof anyCandidate extends fc.Arbitrary<infer T> ? T : never;
/** One that runs every job, so candidates that differ only in price meet often. */
const ableCandidate = fc.record(aPrice).map(
  (estimate): Candidate => ({
    provisions: true,
    os: [...OS],
    arch: [...ARCH],
    docker: true,
    containerNetworking: "per_job",
    maxLifetimeMs: null,
    knowsLabels: true,
    ...estimate,
  }),
);
const aCandidate = fc.oneof(anyCandidate, ableCandidate);

const aJob = fc.record({
  os: fc.constantFrom(null, ...OS),
  arch: fc.constantFrom(null, ...ARCH),
  docker: fc.boolean(),
  jobNetwork: fc.boolean(),
  timeoutMs: fc.integer({ min: 1, max: 3 }),
  expectedMs: fc.integer({ min: 1, max: 4 }),
});

const providerOf = (c: Candidate, at: number): RunnerProvider => {
  const { knowsLabels, microUsdPerMinute, billingStepMs, expectedBootMs, ...capabilities } = c;
  return {
    ...fake(`p${at}`),
    describe: () => capabilities,
    estimate: () =>
      knowsLabels
        ? { microUsdPerMinute, billingStepMs, expectedBootMs }
        : { unsupported: "labels" },
  };
};

function eligible(c: Candidate, req: JobRequirements): boolean {
  const wants: boolean[] = [c.provisions, c.knowsLabels];
  if (req.os) wants.push(c.os.some((os) => os === req.os));
  if (req.arch) wants.push(c.arch.some((arch) => arch === req.arch));
  if (req.docker) wants.push(c.docker === true);
  if (req.jobNetwork) wants.push(c.docker === true, c.containerNetworking === "per_job");
  if (c.maxLifetimeMs) wants.push(c.expectedBootMs + req.timeoutMs <= c.maxLifetimeMs);
  return wants.every(Boolean);
}

/** Minute-price times the time billed, counted a step at a time. */
function costOf(c: Candidate, expectedMs: number): number {
  let billed = 0;
  while (billed < expectedMs) billed += c.billingStepMs;
  return billed * c.microUsdPerMinute;
}

const holds = (property: (req: JobRequirements, candidates: readonly Candidate[]) => void): void =>
  fc.assert(
    fc.property(aJob, fc.array(aCandidate, { maxLength: 5 }), (more, candidates) =>
      property(job(more), candidates),
    ),
    { numRuns: 2_000 },
  );

const pick = (req: JobRequirements, candidates: readonly Candidate[]) => {
  const { choice, dropped } = schedule(req, candidates.map(providerOf));
  const at = choice ? Number(choice.provider.id.slice(1)) : null;
  return { at, candidate: at === null ? null : (candidates[at] as Candidate), dropped };
};

describe("for any job and candidates", () => {
  it("never chooses an ineligible one, and drops exactly those", () => {
    holds((req, candidates) => {
      const { candidate, dropped } = pick(req, candidates);
      if (candidate) expect(eligible(candidate, req)).toBe(true);
      expect(dropped.map((d) => d.providerId)).toEqual(
        candidates.flatMap((c, i) => (eligible(c, req) ? [] : [`p${i}`])),
      );
      // One that only answers unsupported is dropped for that, and for nothing else.
      for (const { providerId, reason } of dropped) {
        const c = candidates[Number(providerId.slice(1))] as Candidate;
        expect(reason === "unsupported").toBe(
          !c.knowsLabels && eligible({ ...c, knowsLabels: true, maxLifetimeMs: null }, req),
        );
      }
    });
  });

  it("chooses one whenever one is eligible", () => {
    holds((req, candidates) => {
      expect(pick(req, candidates).candidate !== null).toBe(
        candidates.some((c) => eligible(c, req)),
      );
    });
  });

  it("chooses the cheapest, then the soonest to boot, then the first id", () => {
    holds((req, candidates) => {
      const { at } = pick(req, candidates);
      const best = candidates
        .map((c, i) => ({ i, cost: costOf(c, req.expectedMs), boot: c.expectedBootMs }))
        .filter(({ i }) => eligible(candidates[i] as Candidate, req))
        .reduce<{ i: number; cost: number; boot: number } | null>((least, next) => {
          if (!least || next.cost < least.cost) return next;
          return next.cost === least.cost && next.boot < least.boot ? next : least;
        }, null);
      expect(at).toBe(best?.i ?? null);
    });
  });

  it("never gives a job with containers one without a network for it", () => {
    holds((req, candidates) => {
      const { candidate } = pick({ ...req, jobNetwork: true }, candidates);
      if (candidate) expect(candidate.containerNetworking).toBe("per_job");
    });
  });

  it("never buys from one that does not provision", () => {
    holds((req, candidates) => {
      const free = candidates.map((c) => ({ ...c, microUsdPerMinute: c.provisions ? 1 : 0 }));
      expect(pick(req, free).candidate?.provisions ?? true).toBe(true);
    });
  });

  it("chooses the same whatever order they come in", () => {
    fc.assert(
      fc.property(
        aJob,
        fc
          .array(aCandidate, { maxLength: 5 })
          .map((candidates) => candidates.map(providerOf))
          .chain((providers) =>
            fc.tuple(
              fc.constant(providers),
              fc.shuffledSubarray(providers, {
                minLength: providers.length,
                maxLength: providers.length,
              }),
            ),
          ),
        (more, [providers, shuffled]) => {
          expect(chosen(job(more), shuffled)).toBe(chosen(job(more), providers));
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
