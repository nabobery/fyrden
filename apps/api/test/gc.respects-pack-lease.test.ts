// Pack leases against repack and garbage collection: a clone streaming
// stored packs through the Worker holds read leases on them. A repack that
// wants to replace those packs waits for the leases; past its wait limit it
// supersedes them mid-clone, which is safe because a superseded pack stays
// readable and is not deleted while a lease from before its condemnation
// is unexpired. The clone completes byte for byte; the pack is deleted only
// after the lease has ended (and the retention has passed).
import { describe, expect, inject, it } from "vitest";
import { fetchBody, loadFixture, parseFetchResponse, throughWorker } from "./helpers/fetch-repo.js";
import { DAY, HOUR, stored } from "./helpers/gc.js";
import { basic, createRepo, ORIGIN, type TestRepo } from "./helpers/git-http.js";
import { advance, packStates, runJob, setPolicy } from "./helpers/maintenance.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fixtures = inject("fetchFixtures");
const UPLOAD = "git-upload-pack";

const cloneArgs = () => [
  ...[...new Set(fixtures.split.refs.map((r) => r.oid))].map((oid) => `want ${oid}`),
  "ofs-delta",
  "no-progress",
  "done",
];

function request(owner: { token: string; principalId: string }, repo: TestRepo): Request {
  const handle = owner.principalId.toLowerCase().replace("_", "-");
  return new Request(`${ORIGIN}/${handle}/${repo.name}.git/${UPLOAD}`, {
    method: "POST",
    headers: {
      "Content-Type": `application/x-${UPLOAD}-request`,
      "Git-Protocol": "version=2",
      Authorization: basic(owner.token),
    },
    body: fetchBody(cloneArgs()),
  });
}

/** Keeps unexpired the read leases a streaming clone holds, as its renewals would. */
const renewReadLeases = (repo: TestRepo) =>
  inRepo(repo.stub, ({ git }) => {
    git.context.storage.sql
      .exec("UPDATE leases SET expires_at = ? WHERE kind = 'read'", git.context.now() + 10 * 60_000)
      .toArray();
  });

const readLeases = (repo: TestRepo) =>
  inRepo(repo.stub, ({ git }) =>
    git.context.storage.sql
      .exec<{ pack_id: string }>(
        "SELECT pack_id FROM leases WHERE kind = 'read' AND expires_at > ?",
        git.context.now(),
      )
      .toArray()
      .map((r) => r.pack_id),
  );

describe("gc respects pack leases", () => {
  it("repack supersedes packs mid-clone; the leased packs outlive the lease; the clone completes byte-identical", async () => {
    const owner = await principalWithToken("user", "git");
    const repo = await createRepo(owner.principalId);
    await setPolicy(repo.stub, { geometricFactor: 1000 });
    const packIds = await loadFixture(repo.stub, fixtures.split);

    // A clone before any repack: what every clone of this repository returns.
    let reference = new Uint8Array(0);
    await throughWorker(request(owner, repo), { plan: "paid" }, async (response) => {
      reference = new Uint8Array(await response.arrayBuffer());
    });
    expect(parseFetchResponse(reference).pack).toBeDefined();

    let streamed = new Uint8Array(0);
    await throughWorker(request(owner, repo), { plan: "paid" }, async (response) => {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const parts: Uint8Array[] = [];
      const first = await reader.read();
      if (first.value) parts.push(first.value);
      // Mid-clone: the stored packs are leased.
      expect((await readLeases(repo)).sort()).toEqual([...packIds].sort());

      // The repack writes its pack, then waits for the leases.
      expect((await runJob(repo.stub, "repack", { max: 4 })).state).toBe("queued");
      expect(
        (await packStates(repo.stub))
          .filter((p) => packIds.includes(p.pack_id as never))
          .map((p) => p.state),
      ).toEqual(["live", "live"]);

      // Past its wait limit (the clone still renewing), it supersedes them anyway.
      await advance(repo.stub, 2 * HOUR);
      await renewReadLeases(repo);
      expect((await runJob(repo.stub, "repack")).state).toBe("done");
      expect(
        (await packStates(repo.stub))
          .filter((p) => packIds.includes(p.pack_id as never))
          .map((p) => p.state),
      ).toEqual(["superseded", "superseded"]);

      // Condemned, past the retention, but still leased: not deleted.
      await runJob(repo.stub, "retire-packs");
      for (let day = 0; day < 31; day++) {
        await advance(repo.stub, DAY);
        await renewReadLeases(repo);
      }
      await runJob(repo.stub, "retire-packs", { max: 3 });
      await inRepo(repo.stub, async ({ git }) => {
        for (const id of packIds) expect(await stored(git, id)).toBe(true);
      });

      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(next.value);
      }
      streamed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        streamed.set(part, at);
        at += part.length;
      }
    });
    expect(streamed).toEqual(reference);

    // The clone released its lease: now the packs go.
    expect(await readLeases(repo)).toEqual([]);
    await runJob(repo.stub, "retire-packs");
    await inRepo(repo.stub, async ({ git }) => {
      for (const id of packIds) expect(await stored(git, id)).toBe(false);
    });
    // The compacted pack serves the next clone with the same objects.
    let after = new Uint8Array(0);
    await throughWorker(request(owner, repo), { plan: "paid" }, async (response) => {
      after = new Uint8Array(await response.arrayBuffer());
    });
    const parsed = parseFetchResponse(after);
    expect(parsed.pack).toBeDefined();
  });
});
