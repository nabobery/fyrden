// Every provider passes one suite, and each of its rules rejects a provider
// that is wrong in that way alone.
import { describe, expect, it } from "vitest";
import { byoProvider, type ProviderCapabilities, type RunnerProvider } from "../src/index.js";
import {
  createFakeProvider,
  describeProviderContract,
  PROVIDER_RULES,
  type ProviderUnderTest,
  ruleViolations,
} from "../testing/index.js";
import { fakeUnderTest, job } from "./helpers/jobs.js";

const byoUnderTest = (): ProviderUnderTest => ({
  provider: byoProvider,
  supported: job({ docker: true, jobNetwork: true }),
  unsupported: [job({ labels: ["anything"] })],
  calls: () => 0,
  made: () => 0,
});

describeProviderContract("fake", () => fakeUnderTest());
describeProviderContract("byo", byoUnderTest);

/** A subject whose provider is the fake's, changed. */
const wrong =
  (change: (real: RunnerProvider, subject: ProviderUnderTest) => Partial<RunnerProvider>) => () => {
    const subject = fakeUnderTest();
    return { ...subject, provider: { ...subject.provider, ...change(subject.provider, subject) } };
  };

const wrongByo = (change: Partial<RunnerProvider>) => () => ({
  ...byoUnderTest(),
  provider: { ...byoProvider, ...change },
});

const described = (more: Partial<ProviderCapabilities>) =>
  wrong((real) => ({ describe: () => ({ ...real.describe(), ...more }) }));

const RULE = {
  quiet: "describe and estimate call nothing and answer the same each time",
  capabilities:
    "a lifetime is a positive whole number or none, and a network per job comes with Docker",
  estimate: "an estimate is whole numbers with a billing step",
  refuses: "a job it cannot run is refused by its estimate and by provision, which makes nothing",
  one: "provision makes one live instance, tagged with its intent",
  lost: "an instance whose answer was lost is found by its intent, and torn down",
  twice: "teardown is done when the instance is gone, the second time too",
  others: "teardown leaves every other instance",
  lists: "listOrphans lists the instances whose intent begins with the tag, and no other",
  token: "the registration token is in no handle, list, refusal or error",
  none: "one that provisions nothing costs nothing, refuses to, and has no instances",
};

const estimated = (more: object) =>
  wrong((real) => ({
    estimate: (req) => {
      const answer = real.estimate(req);
      return "unsupported" in answer ? answer : { ...answer, ...more };
    },
  }));

/** Wrong providers, by the only rule each breaks. */
const WRONG: readonly (readonly [rule: string, how: string, create: () => ProviderUnderTest])[] = [
  [
    RULE.quiet,
    "calls its service to describe itself",
    () => {
      const subject = fakeUnderTest();
      return {
        ...subject,
        provider: {
          ...subject.provider,
          describe: () => {
            void subject.provider.listOrphans("x");
            return subject.provider.describe();
          },
        },
      };
    },
  ],
  [
    RULE.quiet,
    "calls its service to estimate",
    wrong((real) => ({
      estimate: (req) => {
        void real.listOrphans("x");
        return real.estimate(req);
      },
    })),
  ],
  [
    RULE.quiet,
    "estimates something else each time",
    wrong((real) => {
      let n = 0;
      return {
        estimate: (req) => {
          const answer = real.estimate(req);
          return "unsupported" in answer ? answer : { ...answer, expectedBootMs: n++ };
        },
      };
    }),
  ],
  [RULE.quiet, "has no id", () => fakeUnderTest({ id: "" })],
  [RULE.capabilities, "lives no time", described({ maxLifetimeMs: 0 })],
  [RULE.capabilities, "lives part of a millisecond", described({ maxLifetimeMs: 1.5 })],
  [RULE.capabilities, "networks containers without Docker", described({ docker: "unknown" })],
  [RULE.estimate, "costs less than nothing", estimated({ microUsdPerMinute: -1 })],
  [RULE.estimate, "costs no number", estimated({ microUsdPerMinute: Number.NaN })],
  [RULE.estimate, "bills in no step", estimated({ billingStepMs: 0 })],
  [RULE.estimate, "boots in part of a millisecond", estimated({ expectedBootMs: 0.5 })],
  [
    RULE.refuses,
    "estimates a job it cannot run",
    wrong(() => ({
      estimate: () => ({ microUsdPerMinute: 1, billingStepMs: 1, expectedBootMs: 1 }),
    })),
  ],
  [
    RULE.refuses,
    "provisions a job it cannot run",
    wrong((real, { supported }) => ({
      provision: (_req, registration, intent) => real.provision(supported, registration, intent),
    })),
  ],
  [
    RULE.refuses,
    "makes an instance, then refuses",
    wrong((real, { supported }) => ({
      provision: async (req, registration, intent) => {
        if ("unsupported" in real.estimate(req))
          await real.provision(supported, registration, intent);
        return real.provision(req, registration, intent);
      },
    })),
  ],
  [
    RULE.refuses,
    "makes an instance under another intent, then refuses",
    wrong((real, { supported }) => ({
      provision: async (req, registration, intent) => {
        if ("unsupported" in real.estimate(req))
          await real.provision(supported, registration, "elsewhere");
        return real.provision(req, registration, intent);
      },
    })),
  ],
  [
    RULE.refuses,
    "makes an instance, tears it down, then refuses",
    wrong((real, { supported }) => ({
      provision: async (req, registration, intent) => {
        if ("unsupported" in real.estimate(req)) {
          const bought = await real.provision(supported, registration, intent);
          if (!("unsupported" in bought)) await real.teardown(bought);
        }
        return real.provision(req, registration, intent);
      },
    })),
  ],
  [
    RULE.one,
    "makes two instances and tears one down",
    wrong((real) => ({
      provision: async (...args) => {
        if (args[2] === "one-1") {
          const spare = await real.provision(...args);
          if (!("unsupported" in spare)) await real.teardown(spare);
        }
        return real.provision(...args);
      },
    })),
  ],
  [
    RULE.one,
    "names another provider in its handle",
    wrong((real) => ({
      provision: async (...args) => {
        const answer = await real.provision(...args);
        // Only the first rule to look at it: the instance itself is right.
        return "unsupported" in answer || args[2] !== "one-1"
          ? answer
          : { ...answer, providerId: "another" };
      },
    })),
  ],
  [
    RULE.one,
    "makes two instances",
    wrong((real) => ({
      provision: async (...args) => {
        if (args[2] === "one-1") await real.provision(...args);
        return real.provision(...args);
      },
    })),
  ],
  [
    RULE.lost,
    "tags an instance only once it has answered",
    () => {
      const fake = createFakeProvider();
      const subject = fakeUnderTest();
      let lose = false;
      return {
        ...subject,
        made: fake.made,
        provider: {
          ...fake.provider,
          provision: async (req, registration, intent) => {
            if (!lose) return fake.provider.provision(req, registration, intent);
            lose = false;
            await fake.provider.provision(req, registration, "untagged");
            throw new Error("the response was lost");
          },
        },
        loseNextResponse: () => {
          lose = true;
        },
      };
    },
  ],
  [
    RULE.twice,
    "fails to tear down what is gone",
    wrong((real) => ({
      teardown: async (handle) => {
        if ((await real.status(handle)) === "gone") throw new Error("not found");
        return real.teardown(handle);
      },
    })),
  ],
  [
    RULE.others,
    "tears down every instance",
    wrong((real) => ({
      teardown: async () => {
        for (const handle of await real.listOrphans("")) await real.teardown(handle);
      },
    })),
  ],
  [
    RULE.lists,
    "matches a tag anywhere in an intent",
    wrong((real) => ({
      listOrphans: async (tag) =>
        (await real.listOrphans("")).filter((handle) => handle.intent.includes(tag)),
    })),
  ],
  [
    RULE.lists,
    "lists every instance as having the tag for its intent",
    wrong((real) => ({
      listOrphans: async (tag) =>
        (await real.listOrphans(tag)).map((handle) => ({ ...handle, intent: tag })),
    })),
  ],
  [
    RULE.lists,
    "lists an instance as another provider's",
    wrong((real) => ({
      listOrphans: async (tag) =>
        (await real.listOrphans(tag)).map((handle) =>
          // Right where another rule tears down what it lists.
          tag === "task" ? { ...handle, providerId: "another" } : handle,
        ),
    })),
  ],
  [
    RULE.lists,
    "matches only a whole intent",
    wrong((real) => ({
      listOrphans: async (tag) =>
        (await real.listOrphans(tag)).filter((handle) => handle.intent === tag),
    })),
  ],
  [
    RULE.token,
    "puts the token in its handle",
    wrong((real) => ({
      provision: async (req, registration, intent) => {
        const answer = await real.provision(req, registration, intent);
        return "unsupported" in answer ? answer : { ...answer, registration };
      },
    })),
  ],
  [
    RULE.token,
    "puts the token in its error",
    wrong((real) => ({
      provision: (req, registration, intent) =>
        real.provision(req, registration, intent).catch(() => {
          throw new Error(`no answer for ${registration.token}`);
        }),
    })),
  ],
  [
    RULE.token,
    "puts the token in its refusal",
    wrong((real) => ({
      provision: async (req, registration, intent) => {
        const answer = await real.provision(req, registration, intent);
        return "unsupported" in answer ? { unsupported: registration.token } : answer;
      },
    })),
  ],
  [
    RULE.none,
    "costs something",
    wrongByo({
      estimate: () => ({ microUsdPerMinute: 1, billingStepMs: 60_000, expectedBootMs: 0 }),
    }),
  ],
  [
    RULE.none,
    "provisions all the same",
    wrongByo({
      provision: async (_req, _registration, intent) => ({
        providerId: "byo",
        instanceId: "1",
        intent,
      }),
    }),
  ],
  [RULE.none, "has a status", wrongByo({ status: async () => "running" })],
  [
    RULE.none,
    "fails to tear down",
    wrongByo({
      teardown: async () => {
        throw new Error("no");
      },
    }),
  ],
  [
    RULE.none,
    "lists an instance",
    wrongByo({
      listOrphans: async () => [{ providerId: "byo", instanceId: "1", intent: "x" }],
    }),
  ],
];

describe("the contract", () => {
  it.each(WRONG)("%s: rejects one that %s", async (rule, _how, create) => {
    const broken = await ruleViolations(create);
    expect(broken.map((b) => b.rule)).toEqual([rule]);
    expect(broken[0]?.violations.length).toBeGreaterThan(0);
  });

  it("has a wrong provider for each rule", () => {
    expect(new Set(WRONG.map(([rule]) => rule))).toEqual(
      new Set(PROVIDER_RULES.map((rule) => rule.name)),
    );
  });

  it("takes a hosted provider that knows only instance ids it made", async () => {
    const strict = wrong((real) => ({
      teardown: async (handle) => {
        if (!/^fake-\d+$/.test(handle.instanceId)) throw new Error("not an instance id");
        return real.teardown(handle);
      },
    }));
    expect(await ruleViolations(strict)).toEqual([]);
  });

  it("rejects a hosted provider it was given no way to test", async () => {
    const { loseNextResponse: _, ...subject } = fakeUnderTest();
    const broken = await ruleViolations(() => ({ ...subject, unsupported: [] }));
    expect(broken.map((b) => b.rule).sort()).toEqual([RULE.refuses, RULE.lost].sort());
  });
});
