// A job token may fetch its own run's commit, and that commit's history,
// even once no ref reaches it (a branch force-pushed after the run was
// triggered): upload-pack takes the run's checkout commit, read from the
// task the token was verified against, as one more unadvertised tip. A
// commit neither a ref nor the run's commit reaches stays `not our ref`,
// and nothing changes for any other credential.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, json } from "./helpers/api.js";
import { fetchBody, packObjects, parseFetchResponse } from "./helpers/fetch-repo.js";
import { moveRef } from "./helpers/gc.js";
import { basic, ORIGIN } from "./helpers/git-http.js";
import { fetchTask, jobTokenOf, orgRepo, registerRunner } from "./helpers/runners.js";
import { type Fixture, job, started, workflow } from "./helpers/runs.js";

type OrgFixture = Fixture & { org: { id: string; login: string } };

const one = workflow(job("a"));

async function commitOn(f: OrgFixture, branch: string, file: string): Promise<string> {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${f.path}/file-commits`, f.owner.token, {
      branch,
      message: file,
      changes: [{ path: file, content: `${file}\n` }],
    }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
}

async function uploadPack(f: OrgFixture, token: string, args: string[]) {
  const res = await exports.default.fetch(
    `${ORIGIN}/${f.org.login}/${f.repo.name}.git/git-upload-pack`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        Authorization: basic(token),
      },
      body: fetchBody(args),
    },
  );
  expect(res.status).toBe(200);
  return parseFetchResponse(new Uint8Array(await res.arrayBuffer()));
}

/**
 * main: c1 <- c2 <- c3, a run triggered on c3 with its task's job token,
 * then main force-pushed to s1 (a child of c1 on a branch since deleted),
 * leaving c2 and c3 unreachable; g1, another child of c1 whose branch was
 * deleted, is reachable from neither a ref nor the run's commit.
 */
async function forcePushedRun() {
  const f = await orgRepo();
  const c1 = f.sha;
  const c2 = await commitOn(f, "main", "two.txt");
  const c3 = await commitOn(f, "main", "three.txt");
  const runner = await registerRunner(f.org.login, f.owner);
  await started(f, one, { sha: c3 });
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  const token = jobTokenOf(task);

  const stub = env.REPO.getByName(f.repo.id);
  await moveRef(stub, "refs/heads/side", null, c1);
  const s1 = await commitOn(f, "side", "side.txt");
  await moveRef(stub, "refs/heads/gone", null, c1);
  const g1 = await commitOn(f, "gone", "gone.txt");
  await moveRef(stub, "refs/heads/gone", g1, null);
  await moveRef(stub, "refs/heads/main", c3, s1);
  await moveRef(stub, "refs/heads/side", s1, null);
  return { f, runner, token, c1, c2, c3, s1, g1 };
}

const notOurRef = (sha: string) => expect.stringContaining(`not our ref ${sha}`);

describe("a job token fetching its run's commit", () => {
  it("gets it and its history after the branch was force-pushed away", async () => {
    const { f, token, c1, c2, c3 } = await forcePushedRun();
    const full = await uploadPack(f, token, [`want ${c3}`, "ofs-delta", "done"]);
    expect(full.error).toBeUndefined();
    const { oids } = await packObjects(full.pack as Uint8Array);
    expect(oids).toEqual(expect.arrayContaining([c1, c2, c3]));

    // An ancestor of the run's commit, reachable from no ref: served too.
    const ancestor = await uploadPack(f, token, [`want ${c2}`, "ofs-delta", "done"]);
    expect(ancestor.error).toBeUndefined();
    expect((await packObjects(ancestor.pack as Uint8Array)).oids).toContain(c2);
  });

  it("gets it shallow, then deepened, then unshallowed", async () => {
    const { f, token, c1, c2, c3 } = await forcePushedRun();
    const shallow = await uploadPack(f, token, [`want ${c3}`, "deepen 1", "ofs-delta", "done"]);
    expect(shallow.error).toBeUndefined();
    expect(shallow.shallowInfo).toEqual([`shallow ${c3}`]);
    const first = (await packObjects(shallow.pack as Uint8Array)).oids;
    expect(first).toContain(c3);
    expect(first).not.toContain(c2);

    const deeper = await uploadPack(f, token, [
      `want ${c3}`,
      `have ${c3}`,
      `shallow ${c3}`,
      "deepen 2",
      "ofs-delta",
      "done",
    ]);
    expect(deeper.error).toBeUndefined();
    expect(deeper.shallowInfo).toEqual(
      expect.arrayContaining([`shallow ${c2}`, `unshallow ${c3}`]),
    );
    expect((await packObjects(deeper.pack as Uint8Array)).oids).toContain(c2);

    // Lifting the boundary needs it reachable from a tip: the run's commit counts as one.
    const whole = await uploadPack(f, token, [
      `want ${c3}`,
      `have ${c3}`,
      `shallow ${c2}`,
      "deepen 2147483647",
      "ofs-delta",
      "done",
    ]);
    expect(whole.error).toBeUndefined();
    expect(whole.shallowInfo).toEqual([`unshallow ${c2}`]);
    expect((await packObjects(whole.pack as Uint8Array)).oids).toContain(c1);
  });

  it("is refused a commit neither a ref nor the run's commit reaches", async () => {
    const { f, token, g1 } = await forcePushedRun();
    expect((await uploadPack(f, token, [`want ${g1}`, "done"])).error).toEqual(notOurRef(g1));
  });

  it("gives another task's token nothing extra", async () => {
    const { f, c1, c2, c3, s1 } = await forcePushedRun();
    // A second run, on the current tip, with its own task and token.
    await started({ ...f, sha: s1 }, one);
    const other = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(other, 0)).task;
    if (!task) throw new Error("no task");
    const token = jobTokenOf(task);
    expect((await uploadPack(f, token, [`want ${s1}`, "done"])).error).toBeUndefined();
    expect((await uploadPack(f, token, [`want ${c1}`, "done"])).error).toBeUndefined();
    expect((await uploadPack(f, token, [`want ${c3}`, "done"])).error).toEqual(notOurRef(c3));
    expect((await uploadPack(f, token, [`want ${c2}`, "done"])).error).toEqual(notOurRef(c2));
  });

  for (const order of ["the run's token first", "another task's token first"] as const)
    it(`lifts a shallow boundary only for the token whose run reaches it, ${order}`, async () => {
      const fx = await forcePushedRun();
      const { f, c1, c2, c3, s1 } = fx;
      await started({ ...f, sha: s1 }, one);
      const runner = await registerRunner(f.org.login, f.owner);
      const task = (await fetchTask(runner, 0)).task;
      if (!task) throw new Error("no task");
      const other = jobTokenOf(task);
      // A client holding c3 shallow wants c1 (reachable from main) with its whole history.
      const args = [`want ${c1}`, `shallow ${c3}`, "deepen 2147483647", "ofs-delta", "done"];
      const lifted = async () => {
        const res = await uploadPack(f, fx.token, args);
        expect(res.shallowInfo).toEqual([`unshallow ${c3}`]);
        expect((await packObjects(res.pack as Uint8Array)).oids).toContain(c2);
      };
      const kept = async () => {
        const res = await uploadPack(f, other, args);
        expect(res.error).toBeUndefined();
        expect(res.shallowInfo ?? []).not.toContain(`unshallow ${c3}`);
        expect((await packObjects(res.pack as Uint8Array)).oids).not.toContain(c2);
      };
      if (order === "the run's token first") {
        await lifted();
        await kept();
      } else {
        await kept();
        await lifted();
      }
    });
});
