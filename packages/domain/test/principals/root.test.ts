import { describe, expect, it } from "vitest";
import { rootIdentity } from "../../src/principals/root.js";

const user = "usr_01J00000000000000000000001";
const agent = "agt_01J00000000000000000000002";
const org = "org_01J00000000000000000000003";

describe("rootIdentity", () => {
  it("is the user for its own token and for a token delegated to agents", () => {
    expect(rootIdentity({ principalId: user, grantId: null, ceilingIds: [] })).toBe(user);
    expect(rootIdentity({ principalId: user, grantId: "grt_1", ceilingIds: [user, org] })).toBe(
      user,
    );
  });

  it("is a user-owned agent's owner, and an organization's agent itself", () => {
    expect(rootIdentity({ principalId: agent, grantId: null, ceilingIds: [user] })).toBe(user);
    expect(rootIdentity({ principalId: agent, grantId: null, ceilingIds: [org] })).toBe(agent);
  });
});
