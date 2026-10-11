import { describe, expect, it } from "vitest";
import { ownHostsOf } from "../src/git/import/network.js";

describe("ownHostsOf", () => {
  it("includes the request's host, both Workers on its workers.dev subdomain, and configured extras", () => {
    expect(
      ownHostsOf(
        { FYRDEN_OWN_HOSTS: " Git.Example.COM , ," },
        "fyrden-api.acme.workers.dev",
      ).sort(),
    ).toEqual(
      ["fyrden-api.acme.workers.dev", "fyrden-web.acme.workers.dev", "git.example.com"].sort(),
    );
  });

  it("adds no sibling for a custom domain or another Worker's name", () => {
    expect(ownHostsOf({}, "git.example.com")).toEqual(["git.example.com"]);
    expect(ownHostsOf({}, "other.acme.workers.dev")).toEqual(["other.acme.workers.dev"]);
  });
});
