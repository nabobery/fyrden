import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import { ORG_SETTINGS } from "../app/components/settings-shell.js";
import type { PageLinks } from "../app/lib/pages.js";
import Organizations, { loader, meta } from "../app/routes/settings.organizations.js";
import routes from "../app/routes.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const PAGE = "/settings/organizations";
const acme = { id: "org_1", login: "acme", role: "admin" as const };
const beta = { id: "org_2", login: "beta", role: "member" as const };
const NONE: PageLinks = { next: null, first: null };

const load = async (answer: () => Response, path = PAGE) => {
  const { context, calls } = fakeApi(answer);
  const data = await loader({
    request: new Request(`${ORIGIN}${path}`),
    context,
    params: {},
  } as never).catch((thrown: unknown) => thrown);
  return { data, asked: calls.map((c) => c.url) };
};

const shown = (orgs: unknown[], pages = NONE) => renderPage(Organizations, PAGE, { orgs, pages });
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe("the organizations page's data", () => {
  it("is the viewer's list, a hundred a page", async () => {
    const more = { repos_url: "r", members_url: "m", description: null };
    const { data, asked } = await load(() =>
      json([
        { ...acme, ...more },
        { ...beta, ...more },
      ]),
    );
    expect(asked).toEqual([`${ORIGIN}/api/user/orgs?per_page=100&page=1`]);
    expect(data).toEqual({ orgs: [acme, beta], pages: NONE });
  });

  it("links the next page exactly when the API does, and the first from any other", async () => {
    const link = (rel: string) => ({
      Link: `<${ORIGIN}/api/user/orgs?per_page=100&page=2>; rel="${rel}"`,
    });
    const first = await load(() => json([acme], 200, link("next")));
    expect(first.data).toMatchObject({ pages: { next: `${PAGE}?page=2`, first: null } });
    const last = await load(() => json([acme], 200, link("prev")), `${PAGE}?page=2`);
    expect(last.asked).toEqual([`${ORIGIN}/api/user/orgs?per_page=100&page=2`]);
    expect(last.data).toMatchObject({ pages: { next: null, first: PAGE } });
  });

  it.each(["?page=0", "?page=-1", "?page=x", "?page=1.5"])(
    "is the first page for %s",
    async (query) => {
      const { asked } = await load(() => json([acme]), `${PAGE}${query}`);
      expect(asked).toEqual([`${ORIGIN}/api/user/orgs?per_page=100&page=1`]);
    },
  );

  it("links pages of the site when the browser asks for data alone", async () => {
    const { data } = await load(
      () => json([acme], 200, { Link: `<${ORIGIN}/api/user/orgs?page=3>; rel="next"` }),
      `${PAGE}.data?page=2`,
    );
    expect(data).toMatchObject({ pages: { next: `${PAGE}?page=3`, first: PAGE } });
  });

  it("is a page to sign in on, signed out, and the API's status when it refuses", async () => {
    const out = (await load(() => json({ status: 401 }, 401))).data as Response;
    expect(out.status).toBe(302);
    expect(out.headers.get("Location")).toContain("/auth/sign-in?return_to=");
    const refused = (await load(() => json({ status: 429, detail: "Slow down." }, 429))).data;
    expect(refused).toMatchObject({ init: { status: 429 }, data: "Slow down." });
  });
});

describe("the organizations page", () => {
  it("links an owner to every settings page there is, each a page of the site", () => {
    const html = shown([acme]);
    const expected = ORG_SETTINGS.map((p) => p.path({ kind: "organization", org: "acme" }));
    expect(expected.length).toBeGreaterThan(0);
    expect(hrefs(html)).toEqual(expected);
    for (const path of expected) expect(matchRoutes(routes as never, path), path).not.toBeNull();
    expect(html).toContain("Owner");
  });

  it("links a member to none of them", () => {
    const html = shown([beta]);
    expect(html).toContain("beta");
    expect(html).toContain("Member");
    expect(hrefs(html)).toEqual([]);
  });

  it("names the organization in each link", () => {
    const text = shown([acme]).replace(/<[^>]+>/g, "");
    for (const page of ORG_SETTINGS) expect(text).toContain(`acme: ${page.label}`);
  });

  it("says so when there are none, and when a page is past the last", () => {
    expect(shown([])).toContain("You are not a member of any organization.");
    const past = shown([], { next: null, first: PAGE });
    expect(past).toContain("No more organizations.");
    expect(hrefs(past)).toEqual([PAGE]);
  });

  it("pages many with plain links", () => {
    expect(hrefs(shown([beta], { next: `${PAGE}?page=3`, first: PAGE }))).toEqual([
      PAGE,
      `${PAGE}?page=3`,
    ]);
  });

  it("shows a name as text", () => {
    const html = shown([{ ...beta, login: HOSTILE }]);
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
  });

  it("has a title", () => {
    expect(meta()).toEqual([{ title: "Organizations · Fyrden" }]);
  });
});
