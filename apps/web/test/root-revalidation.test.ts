// A page that holds work (conflict edits) is never replaced by an error
// page while it reads itself again: the site's data (who is signed in, the
// API's version) is not read again for the same page, and a failure to read
// it leaves it blank instead of failing. Run over the whole route tree, the
// root's loader and the conflicts page's, in React Router's own router.

import { createMemoryRouter, RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/lib/cloudflare.server.js";
import { loader as rootLoader, shouldRevalidate } from "../app/root.js";
import { loader as conflictsLoader } from "../app/routes/repo.pull.conflicts.js";
import { json } from "./helpers/context.js";
import { pullRequest, VIEWER } from "./helpers/pulls.js";

const PAGE = "/ada/demo/pull/7/conflicts";
const SNAPSHOT = "e".repeat(80);

/** fyrden-api behind the binding, healthy until `failing` is set. */
function stack() {
  const state = { failing: false, rpcCalls: 0 };
  const context = new RouterContextProvider();
  const API = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/auth/session") {
        if (state.failing) throw new TypeError("The service binding refused the request.");
        return json({ user: { id: VIEWER, handle: "ada" } });
      }
      if (path.endsWith("/conflicts"))
        return state.failing
          ? json({ code: "unavailable", detail: "Try again." }, 503)
          : json({
              base_sha: "a".repeat(40),
              head_sha: "b".repeat(40),
              conflict_snapshot: SNAPSHOT,
              files: [
                { path: "a.txt", kind: "content", editable: true, content: "x\n", conflicts: 1 },
              ],
            });
      return json(pullRequest());
    },
    rpcVersion: async () => {
      // Only the root's loader asks for it: a count of its runs.
      state.rpcCalls++;
      if (state.failing) throw new TypeError("The service binding refused the call.");
      return 1;
    },
  };
  context.set(cloudflareContext, { env: { API } as unknown as Env, ctx: {} as ExecutionContext });
  // The browser's session rides along on every request, as a page's would.
  const signedIn = (request: Request) =>
    new Request(request.url, { headers: { Cookie: "fyrden_session=s" } });
  // biome-ignore lint/suspicious/noExplicitAny: the loaders' own argument types
  const run = (loader: (args: any) => unknown) => (args: { request: Request; params: unknown }) =>
    loader({ ...args, request: signedIn(args.request), context });
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        loader: run(rootLoader),
        shouldRevalidate,
        children: [
          {
            id: "conflicts",
            path: ":owner/:repo/pull/:number/conflicts",
            loader: run(conflictsLoader),
            // As a refused resolution answers: the page then reads itself again.
            action: () => ({ error: "The base moved.", stale: true, snapshot: SNAPSHOT }),
          },
        ],
      },
    ],
    { initialEntries: [PAGE] },
  );
  return { router, state };
}

/** Resolves once the router has nothing in flight. */
function settled(router: ReturnType<typeof createMemoryRouter>): Promise<void> {
  return new Promise((done) => {
    const check = () =>
      router.state.initialized &&
      router.state.navigation.state === "idle" &&
      router.state.revalidation === "idle";
    if (check()) return done();
    const stop = router.subscribe(() => {
      if (!check()) return;
      stop();
      done();
    });
  });
}

describe("a page holding conflict edits, read again", () => {
  it("keeps the page (no error boundary) when the API fails mid-way, re-read or after a refusal", async () => {
    const { router, state } = stack();
    await settled(router);
    expect(router.state.errors).toBeNull();
    expect(router.state.loaderData.root).toEqual({
      user: { id: VIEWER, handle: "ada" },
      apiRpcVersion: 1,
    });
    const rootRuns = state.rpcCalls;

    state.failing = true;
    // "Read the conflicts again" (a revalidation).
    void router.revalidate();
    await settled(router);
    expect(router.state.errors).toBeNull();
    // The page's own data answers its failure (the page keeps the editors it holds).
    expect(router.state.loaderData.conflicts).toMatchObject({ conflicts: null });
    expect((router.state.loaderData.conflicts as { failure: string | null }).failure).toBeTruthy();
    // A resolution sent and refused: the page reads itself again after it.
    const form = new FormData();
    form.set("conflict_snapshot", SNAPSHOT);
    void router.navigate(PAGE, { formMethod: "post", formData: form });
    await settled(router);
    expect(router.state.errors).toBeNull();
    expect(router.state.actionData?.conflicts).toMatchObject({ stale: true });
    // The site's data was not read again for the same page: as it was.
    expect(state.rpcCalls).toBe(rootRuns);
    expect(router.state.loaderData.root).toEqual({
      user: { id: VIEWER, handle: "ada" },
      apiRpcVersion: 1,
    });
    router.dispose();
  });

  it("reads the site's data again on going to another page, and fails blank, not with an error page", async () => {
    const { state } = stack();
    state.failing = true;
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: {
        API: {
          fetch: async () => {
            throw new TypeError("refused");
          },
          rpcVersion: async () => {
            throw new TypeError("refused");
          },
        },
      } as unknown as Env,
      ctx: {} as ExecutionContext,
    });
    const data = await rootLoader({
      request: new Request("https://fyrden.test/", { headers: { Cookie: "fyrden_session=s" } }),
      context,
      params: {},
    } as never);
    expect(data).toEqual({ user: null, apiRpcVersion: null });
    const at = (path: string) => new URL(`https://fyrden.test${path}`);
    const args = (from: string, to: string) => ({
      currentUrl: at(from),
      nextUrl: at(to),
      currentParams: {},
      nextParams: {},
      defaultShouldRevalidate: true,
    });
    expect(shouldRevalidate(args(PAGE, PAGE))).toBe(false);
    expect(shouldRevalidate(args(PAGE, "/ada/demo"))).toBe(true);
  });
});
