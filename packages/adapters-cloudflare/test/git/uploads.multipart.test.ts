import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { scratchPrefix, UPLOAD_TTL_MS } from "../../src/git/index.js";
import { inProbe, newNetworkId, newProbe } from "./harness.js";

// A multipart upload outside the pack key (a chunked upload's scratch
// object) is recorded with its key, so the reaper aborts it there.

describe("uploads: recorded multipart uploads", () => {
  it("records a scratch key with the id, clears it once completed, and refuses other keys", async () => {
    const { stub, networkId } = await newProbe();
    const outcome = await inProbe(stub, async ({ git }) => {
      const upload = git.uploads.begin({
        networkId,
        principal: "usr_a",
        commands: [],
        atomic: true,
        withPack: true,
        ttlMs: UPLOAD_TTL_MS,
        leaseTtlMs: 60_000,
      });
      const key = `${scratchPrefix(networkId, upload.uploadId)}pack`;
      const before = git.uploads.multipartOf(upload.uploadId);
      const multipart = await env.GIT.createMultipartUpload(key);
      const recorded = git.uploads.recordMultipart(upload.uploadId, multipart.uploadId, key);
      const after = git.uploads.multipartOf(upload.uploadId);
      const refused: string[] = [];
      for (const bad of [
        `${scratchPrefix(networkId, upload.uploadId)}../p/x.pack`,
        `${scratchPrefix(newNetworkId(), upload.uploadId)}pack`,
        `net/${networkId}/p/${upload.packId}.pack`,
        `${scratchPrefix(networkId, upload.uploadId)}PACK`,
      ]) {
        try {
          git.uploads.recordMultipart(upload.uploadId, multipart.uploadId, bad);
        } catch (error) {
          refused.push((error as Error).name);
        }
      }
      await multipart.abort();
      git.uploads.clearMultipart(upload.uploadId);
      return {
        before,
        recorded,
        after,
        refused,
        cleared: git.uploads.multipartOf(upload.uploadId),
        id: multipart.uploadId,
        key,
      };
    });
    expect(outcome.before).toBeUndefined();
    expect(outcome.recorded).toBe(true);
    expect(outcome.after).toEqual({ key: outcome.key, multipartId: outcome.id });
    expect(outcome.refused).toEqual(["RangeError", "RangeError", "RangeError", "RangeError"]);
    expect(outcome.cleared).toBeUndefined();
  });
});
