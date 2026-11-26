// GitHub's `Link` header on lists paged by `page` and `per_page`: `prev`,
// `next`, `last` and `first`, each the request's own URL with only `page`
// changed, the last page worked out from `total_count` and the page size the
// list reads (`gh variable list` asks 100 of a list that gives 30 at most and
// follows `next`).
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { api, user, type Who } from "./helpers/api.js";
import { repoOf } from "./helpers/ci-secrets.js";
import { ORIGIN } from "./helpers/git-http.js";

type Listed = { total_count: number; variables: { name: string }[] };

let owner: Who;
let three: string;
let many: string;

async function withVariables(count: number): Promise<string> {
  const repo = await repoOf(owner.principalId);
  const path = `/repos/${owner.handle}/${repo.name}/actions/variables`;
  for (let i = 1; i <= count; i++) {
    const res = await api("POST", path, owner.token, {
      name: `V${String(i).padStart(2, "0")}`,
      value: "x",
    });
    expect(res.status).toBe(201);
  }
  return path;
}

const get = (url: string) =>
  exports.default.fetch(url, { headers: { Authorization: `Bearer ${owner.token}` } });

function links(res: Response): [string, string][] {
  const header = res.headers.get("Link");
  if (header === null) return [];
  return header.split(", ").map((part) => {
    const match = /^<([^>]+)>; rel="([a-z]+)"$/.exec(part);
    if (!match) throw new Error(`not a link: ${part}`);
    return [match[2] as string, match[1] as string];
  });
}

beforeAll(async () => {
  owner = await user();
  three = await withVariables(3);
  many = await withVariables(31);
});

describe("a list paged by page and per_page", () => {
  it("links the next and last pages from the first, keeping the rest of the URL", async () => {
    const url = `${ORIGIN}/api${three}?per_page=1&visibility=x%20y`;
    const res = await get(url);
    expect(res.status).toBe(200);
    expect((await res.json<Listed>()).variables.map((v) => v.name)).toEqual(["V01"]);
    expect(links(res)).toEqual([
      ["next", `${url}&page=2`],
      ["last", `${url}&page=3`],
    ]);
  });

  it("links every relation from a middle page, replacing only page where it stands", async () => {
    const url = (page: number) => `${ORIGIN}/api${three}?page=${page}&per_page=1`;
    const res = await get(url(2));
    expect(links(res)).toEqual([
      ["prev", url(1)],
      ["next", url(3)],
      ["last", url(3)],
      ["first", url(1)],
    ]);
  });

  it("links back from the last page and from past it", async () => {
    const url = (page: number) => `${ORIGIN}/api${three}?per_page=1&page=${page}`;
    expect(links(await get(url(3)))).toEqual([
      ["prev", url(2)],
      ["first", url(1)],
    ]);
    const past = await get(url(4));
    expect((await past.json<Listed>()).variables).toEqual([]);
    expect(links(past)).toEqual([
      ["prev", url(3)],
      ["first", url(1)],
    ]);
  });

  it("names one page however page is repeated", async () => {
    const res = await get(`${ORIGIN}/api${three}?page=2&per_page=1&page=9`);
    expect(links(res)).toContainEqual(["next", `${ORIGIN}/api${three}?page=3&per_page=1`]);
  });

  it("links under /api/v3 when asked there", async () => {
    const url = `${ORIGIN}/api/v3${three}?per_page=2`;
    const res = await exports.default.fetch(url, {
      headers: { Authorization: `token ${owner.token}` },
    });
    expect(links(res)).toEqual([
      ["next", `${url}&page=2`],
      ["last", `${url}&page=2`],
    ]);
  });

  it("counts pages by the size the list reads, keeping the size asked", async () => {
    const url = (page: number) => `${ORIGIN}/api/v3${many}?per_page=100&page=${page}`;
    const first = await exports.default.fetch(url(1), {
      headers: { Authorization: `token ${owner.token}` },
    });
    const listed = await first.json<Listed>();
    expect(listed.total_count).toBe(31);
    expect(listed.variables).toHaveLength(30);
    expect(links(first)).toEqual([
      ["next", url(2)],
      ["last", url(2)],
    ]);
    const next = links(first)[0]?.[1] ?? "";
    const second = await exports.default.fetch(next, {
      headers: { Authorization: `token ${owner.token}` },
    });
    expect((await second.json<Listed>()).variables.map((v) => v.name)).toEqual(["V31"]);
    expect(links(second)).toEqual([
      ["prev", url(1)],
      ["first", url(1)],
    ]);
  });

  it("sends none for one page, an empty list or a refusal", async () => {
    expect((await get(`${ORIGIN}/api${three}`)).headers.get("Link")).toBeNull();
    const empty = await withVariables(0);
    const none = await get(`${ORIGIN}/api${empty}?per_page=1`);
    expect(await none.json<Listed>()).toMatchObject({ total_count: 0 });
    expect(none.headers.get("Link")).toBeNull();
    const refused = await get(`${ORIGIN}/api${three}?per_page=0`);
    expect(refused.status).toBe(422);
    expect(refused.headers.get("Link")).toBeNull();
  });
});
