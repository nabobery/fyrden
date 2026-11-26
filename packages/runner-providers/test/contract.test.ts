// Every provider passes one suite, and each of its rules rejects a provider
// that is wrong in that way alone.
import { describe, expect, it } from "vitest";
import {
  byoProvider,
  type InstanceHandle,
  isUnsupported,
  type ProviderCapabilities,
  type RunnerProvider,
} from "../src/index.js";
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
  live: () => 0,
});

describeProviderContract("fake", () => fakeUnderTest());
describeProviderContract("byo", byoUnderTest);

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
  outage: "a service that fails is an error, never a list, a status or a teardown that is done",
  none: "one that provisions nothing costs nothing, refuses to, and has no instances",
};

const estimated = (more: object) =>
  wrong((real) => ({
    estimate: (req) => {
      const answer = real.estimate(req);
      return "unsupported" in answer ? answer : { ...answer, ...more };
    },
  }));

/** Fails with the last token it was given somewhere in its error. */
const failing = (name: "status" | "teardown" | "listOrphans", error: (token: string) => unknown) =>
  wrong((real) => {
    let token = "";
    const fail = () => {
      throw error(token);
    };
    return {
      provision: (req, registration, intent) => {
        token = registration.token;
        return real.provision(req, registration, intent);
      },
      ...{
        status: { status: (handle: InstanceHandle) => real.status(handle).catch(fail) },
        teardown: { teardown: (handle: InstanceHandle) => real.teardown(handle).catch(fail) },
        listOrphans: { listOrphans: (tag: string) => real.listOrphans(tag).catch(fail) },
      }[name],
    };
  });

const lostWith = (error: (token: string) => unknown) =>
  wrong((real) => ({
    provision: (req, registration, intent) =>
      real.provision(req, registration, intent).catch((why: Error) => {
        throw why.message.includes("lost") ? error(registration.token) : why;
      }),
  }));

/** Numbers its instances by the lowest number free; its handles are told apart by intent, or not. */
const reusesIds = (byIntent: boolean) =>
  wrong((real) => {
    const slots = new Map<string, InstanceHandle>();
    const outer = (handle: InstanceHandle) => {
      const known = [...slots].find(([, inner]) => inner.instanceId === handle.instanceId);
      let n = 1;
      while (slots.has(`${n}`)) n++;
      const instanceId = known?.[0] ?? `${n}`;
      slots.set(instanceId, handle);
      return { ...handle, instanceId };
    };
    const inner = (handle: InstanceHandle) => {
      const found = slots.get(handle.instanceId);
      return found && (!byIntent || found.intent === handle.intent) ? found : handle;
    };
    return {
      provision: async (...args) => {
        const answer = await real.provision(...args);
        return isUnsupported(answer) ? answer : outer(answer);
      },
      status: (handle) => real.status(inner(handle)),
      teardown: async (handle) => {
        const found = inner(handle);
        await real.teardown(found);
        if (found !== handle) slots.delete(handle.instanceId);
      },
      listOrphans: async (tag) => (await real.listOrphans(tag)).map(outer),
    };
  });

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
        live: fake.live,
        outage: fake.outage,
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
    RULE.lost,
    "buys a second instance when an answer is lost",
    wrong((real) => ({
      provision: (req, registration, intent) =>
        real.provision(req, registration, intent).catch(async (error) => {
          await real.provision(req, registration, "elsewhere");
          throw error;
        }),
    })),
  ],
  [
    RULE.twice,
    "hides an instance for a teardown",
    wrong((real) => {
      const hidden = new Set<string>();
      return {
        status: async (handle) => (hidden.has(handle.instanceId) ? "gone" : real.status(handle)),
        teardown: async (handle) => {
          // Only where no other rule counts the instances left.
          if (handle.intent !== "down-1") return real.teardown(handle);
          hidden.add(handle.instanceId);
        },
        listOrphans: async (tag) =>
          (await real.listOrphans(tag)).filter((handle) => !hidden.has(handle.instanceId)),
      };
    }),
  ],
  [
    RULE.twice,
    "fails to tear down what is gone",
    wrong((real) => ({
      teardown: async (handle) => {
        // Only where no other rule tears down twice.
        if (handle.intent === "down-1" && (await real.status(handle)) === "gone")
          throw new Error("not found");
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
  [RULE.others, "gives an instance's id to a later one", reusesIds(false)],
  [RULE.others, "gives an instance's id to a later one of its intent", reusesIds(true)],
  [
    RULE.others,
    "fails to tear down what is gone once another has its intent",
    wrong((real) => ({
      teardown: async (handle) => {
        const others = await real.listOrphans(handle.intent);
        if (others.some(({ instanceId }) => instanceId !== handle.instanceId))
          if ((await real.status(handle)) === "gone") throw new Error("not found");
        return real.teardown(handle);
      },
    })),
  ],
  [
    RULE.others,
    "has no status for an instance made after one was torn down",
    wrong((real) => {
      let torn = false;
      return {
        teardown: async (handle) => {
          await real.teardown(handle);
          torn = true;
        },
        status: async (handle) => {
          const status = await real.status(handle);
          return torn && status !== "gone" ? { unsupported: "status" } : status;
        },
      };
    }),
  ],
  [
    RULE.lost,
    "has no status for an instance whose answer was lost",
    wrong((real) => ({
      status: async (handle) =>
        handle.intent === "lost-1" ? { unsupported: "status" } : real.status(handle),
    })),
  ],
  [
    RULE.lost,
    "hides an instance whose answer was lost for a teardown",
    wrong((real) => {
      let hidden = false;
      return {
        teardown: async (handle) => {
          if (handle.intent !== "lost-1") return real.teardown(handle);
          hidden = true;
        },
        listOrphans: async (tag) => (hidden && tag === "lost-1" ? [] : real.listOrphans(tag)),
      };
    }),
  ],
  [
    RULE.lists,
    "lists one page",
    wrong((real) => ({
      listOrphans: async (tag) => (await real.listOrphans(tag)).slice(0, 100),
    })),
  ],
  [
    RULE.lists,
    "lists its first page for every page",
    wrong((real) => ({
      listOrphans: async (tag) => {
        const all = await real.listOrphans(tag);
        return all.map((handle, n) => all[n % 50] ?? handle);
      },
    })),
  ],
  [
    RULE.lists,
    "matches a tag in any case",
    wrong((real) => ({
      listOrphans: async (tag) =>
        (await real.listOrphans("")).filter(({ intent }) =>
          intent.toLowerCase().startsWith(tag.toLowerCase()),
        ),
    })),
  ],
  [
    RULE.lists,
    "keeps an intent in lower case",
    wrong((real) => ({
      provision: async (req, registration, intent) => {
        const answer = await real.provision(req, registration, intent.toLowerCase());
        return isUnsupported(answer) ? answer : { ...answer, intent };
      },
      listOrphans: (tag) => real.listOrphans(tag.toLowerCase()),
    })),
  ],
  [
    RULE.lists,
    "gives back an intent in lower case",
    wrong((real) => ({
      provision: (req, registration, intent) =>
        real.provision(req, registration, intent.toLowerCase()),
      listOrphans: (tag) => real.listOrphans(tag.toLowerCase()),
    })),
  ],
  [
    RULE.outage,
    "lists nothing when it cannot list",
    wrong((real) => ({ listOrphans: (tag) => real.listOrphans(tag).catch(() => []) })),
  ],
  [
    RULE.outage,
    "lists the pages it got when one fails",
    wrong((real) => ({
      listOrphans: async (tag) => {
        const listed = await real.listOrphans(tag);
        const pages = listed.slice(0, 50);
        for (let n = 50; n < listed.length; n += 50)
          try {
            pages.push(...(await real.listOrphans(tag)).slice(n, n + 50));
          } catch {
            return pages;
          }
        return pages;
      },
    })),
  ],
  [
    RULE.outage,
    "is done tearing down what it could not",
    wrong((real) => ({ teardown: (handle) => real.teardown(handle).catch(() => {}) })),
  ],
  [
    RULE.outage,
    "takes an instance it cannot ask about as gone",
    wrong((real) => ({ status: (handle) => real.status(handle).catch(() => "gone" as const) })),
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
    "puts the token in its error's cause",
    lostWith((token) => new Error("no answer", { cause: new Error(token) })),
  ],
  [
    RULE.token,
    "puts the token in its error's request",
    lostWith((token) => Object.assign(new Error("no answer"), { request: { body: { token } } })),
  ],
  [
    RULE.token,
    "puts the token in one of its errors",
    lostWith((token) => new AggregateError([new Error("no"), new Error(token)], "no answer")),
  ],
  [
    RULE.token,
    "puts the token in an error that holds itself",
    lostWith((token) => {
      const error = Object.assign(new Error("no answer"), { token, self: {} });
      error.self = error;
      return error;
    }),
  ],
  [
    RULE.token,
    "puts the token in its error's name",
    lostWith((token) => Object.assign(new Error("no answer"), { name: token })),
  ],
  [
    RULE.token,
    "puts the token in its error's map",
    lostWith((token) =>
      Object.assign(new Error("no answer"), { request: new Map([["authorization", token]]) }),
    ),
  ],
  [
    RULE.token,
    "puts the token in its error's set",
    lostWith((token) => Object.assign(new Error("no answer"), { tried: new Set([token]) })),
  ],
  [
    RULE.token,
    "puts the token in its error's headers",
    lostWith((token) =>
      Object.assign(new Error("no answer"), { headers: new Headers({ authorization: token }) }),
    ),
  ],
  [
    RULE.token,
    "puts the token in a status it cannot get",
    failing("status", (token) => new Error(token)),
  ],
  [
    RULE.token,
    "puts the token in a teardown that fails",
    failing("teardown", (token) => new Error(token)),
  ],
  [
    RULE.token,
    "puts the token in a list it cannot get",
    failing("listOrphans", (token) => new Error(token)),
  ],
  [
    RULE.token,
    "puts the token in a provision that fails",
    wrong((real) => ({
      provision: (req, registration, intent) =>
        real.provision(req, registration, intent).catch((why: Error) => {
          throw why.message.includes("down") ? new Error(registration.token) : why;
        }),
    })),
  ],
  [
    RULE.token,
    "puts the token in its list of what was lost",
    wrong((real) => {
      let lost: object | null = null;
      return {
        provision: (req, registration, intent) =>
          real.provision(req, registration, intent).catch((why: Error) => {
            if (why.message.includes("lost")) lost = { intent, registration };
            throw why;
          }),
        listOrphans: async (tag) =>
          (await real.listOrphans(tag)).map((handle) =>
            lost && handle.intent === "token-3" ? { ...handle, lost } : handle,
          ),
      };
    }),
  ],
  [
    RULE.token,
    "puts the token in its list",
    wrong((real) => {
      let registration = {};
      return {
        provision: (req, given, intent) => {
          registration = given;
          return real.provision(req, given, intent);
        },
        listOrphans: async (tag) =>
          (await real.listOrphans(tag)).map((handle) => ({ ...handle, registration })),
      };
    }),
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

  it("finds a token after a provider that overwrites the one it is given", async () => {
    const overwrites = wrong((real) => ({
      provision: (req, registration, intent) => {
        Object.assign(registration, { token: "spent" });
        return real.provision(req, registration, intent);
      },
    }));
    const thrown = await ruleViolations(overwrites);
    expect(thrown.map((b) => b.rule)).toContain(RULE.token);
    expect(thrown.flatMap((b) => b.violations).join()).toMatch(/read only/);
    const broken = await ruleViolations(lostWith((token) => new Error(token)));
    expect(broken.map((b) => b.rule)).toEqual([RULE.token]);
  });

  it("reports a rule that a provider throws out of", async () => {
    const throws = wrong(() => ({
      listOrphans: () => {
        throw new Error("thrown, not rejected");
      },
    }));
    const broken = await ruleViolations(throws);
    expect(broken.map((b) => b.rule)).toContain(RULE.outage);
    expect(broken.flatMap((b) => b.violations).join()).toContain("thrown, not rejected");
  });

  it("reports a provider that cannot describe itself", async () => {
    const broken = await ruleViolations(
      wrong(() => ({
        describe: () => {
          throw new Error("cannot describe");
        },
      })),
    );
    expect(broken.map((b) => b.rule)).toContain(RULE.quiet);
    expect(broken[0]?.violations.join()).toContain("cannot describe");
  });

  it("reports a rule that throws what cannot be read", async () => {
    const error = new Error("no");
    Object.defineProperty(error, "name", {
      get: () => {
        throw new Error("unreadable");
      },
    });
    const broken = await ruleViolations(wrong(() => ({ status: () => Promise.reject(error) })));
    expect(broken.map((b) => b.rule)).toContain(RULE.one);
  });

  it("takes one that lists in pages, and fails when one fails", async () => {
    const paged = wrong((real) => ({
      listOrphans: async (tag) => {
        const listed = await real.listOrphans(tag);
        const pages = listed.slice(0, 50);
        for (let n = 50; n < listed.length; n += 50)
          pages.push(...(await real.listOrphans(tag)).slice(n, n + 50));
        return pages;
      },
    }));
    expect(await ruleViolations(paged)).toEqual([]);
  });

  it("takes an error that cannot be read whole, or is deep", async () => {
    let deep: object = {};
    for (let n = 0; n < 100_000; n++) deep = { deep };
    const error = Object.assign(new Error("no answer"), { deep });
    for (const property of ["closed", "name"])
      Object.defineProperty(error, property, {
        get: () => {
          throw new Error(property);
        },
      });
    expect(await ruleViolations(lostWith(() => error))).toEqual([]);
  });

  it("rejects a hosted provider it was given no way to test", async () => {
    const broken = await ruleViolations(() => {
      const { loseNextResponse: _, outage: __, ...subject } = fakeUnderTest();
      return { ...subject, unsupported: [] };
    });
    expect(broken.map((b) => b.rule).sort()).toEqual([RULE.refuses, RULE.lost, RULE.outage].sort());
  });
});
