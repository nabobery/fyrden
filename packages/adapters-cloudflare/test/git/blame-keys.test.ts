// Where blame checkpoints live in the git bucket: under the repository's id
// alone, never a network's, since a restored database can't know which
// networks the repository has been in since its backup.
import { describe, expect, it } from "vitest";
import {
  blameCheckpointKey,
  blameCheckpointPrefix,
  parseBlameCheckpointKey,
} from "../../src/git/keys.js";

const REPO = "rep_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const RUN = "01J9ABCDEFGHJKMNPQRSTVWXYZ";
const STAMP = "01J9ZZZZZZZZZZZZZZZZZZZZZZ";

describe("blame checkpoint keys", () => {
  it("are under repo/<id>/blame/, one folder a run, generation then a ULID", () => {
    expect(blameCheckpointPrefix(REPO)).toBe(`repo/${REPO}/blame/`);
    const key = blameCheckpointKey({ repoId: REPO, runId: RUN, generation: 7, ulid: STAMP });
    expect(key).toBe(`repo/${REPO}/blame/${RUN}/7-${STAMP}`);
    expect(key.startsWith(blameCheckpointPrefix(REPO))).toBe(true);
  });

  it("read back the run, generation and ULID of a key under the prefix, and nothing else", () => {
    const key = blameCheckpointKey({ repoId: REPO, runId: RUN, generation: 0, ulid: STAMP });
    expect(parseBlameCheckpointKey(REPO, key)).toEqual({ runId: RUN, generation: 0, ulid: STAMP });
    for (const other of [
      `repo/${REPO}/blame/${RUN}/x-${STAMP}`,
      `repo/${REPO}/blame/${RUN}/7-${STAMP}/more`,
      `repo/${REPO}/blame/not-a-ulid/7-${STAMP}`,
      `repo/${REPO}/blame/${RUN}/07-${STAMP}`,
      `repo/rep_01HYYYYYYYYYYYYYYYYYYYYYYY/blame/${RUN}/7-${STAMP}`,
      `net/x/blame/${RUN}/7-${STAMP}`,
    ])
      expect([other, parseBlameCheckpointKey(REPO, other)]).toEqual([other, undefined]);
  });

  it("refuse an id that isn't a repository's, a run or ULID that isn't one, or a bad generation", () => {
    const good = { repoId: REPO, runId: RUN, generation: 1, ulid: STAMP };
    expect(() => blameCheckpointPrefix("net_01HZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(RangeError);
    expect(() => blameCheckpointPrefix("../x")).toThrow(RangeError);
    for (const bad of [{ runId: "run" }, { ulid: "x" }, { generation: -1 }, { generation: 1.5 }])
      expect(() => blameCheckpointKey({ ...good, ...bad })).toThrow(RangeError);
  });
});
