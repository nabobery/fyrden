import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createServerRepo,
  extRemote,
  type ServerRepo,
} from "../../testing/ext-transport/harness.js";
import { commit, fsck, objectSet, Scratch, sourceRepo } from "./support.js";

/*
 * The shared `ext::` test transport end to end: stock git pushes through
 * the receive path into a test server directory, then clones it back
 * through upload-pack, protocol v2.
 */

const scratch = new Scratch();
const servers: ServerRepo[] = [];
afterEach(async () => {
  await scratch.cleanup();
  for (const server of servers.splice(0)) await server.dispose();
});

describe("push, then clone back over the shared ext transport", () => {
  it("a clone of what was pushed holds the same objects and passes fsck", async () => {
    const source = await sourceRepo(scratch);
    await commit(source, { "a.txt": "1\n", "dir/b.txt": "b\n" }, "one");
    await commit(source, { "a.txt": "2\n" }, "two");
    await source.git(["tag", "-a", "v1", "-m", "v1"]);
    const server = await createServerRepo();
    servers.push(server);
    const url = extRemote(server.dir);
    await source.git(["-c", "protocol.ext.allow=always", "push", "-q", url, "main", "v1"]);
    await commit(source, { "dir/c.txt": "c\n" }, "three");
    await source.git(["-c", "protocol.ext.allow=always", "push", "-q", url, "main"]);

    const client = await scratch.sandbox();
    const cwd = join(client.dir, "clone");
    await client.git(
      ["-c", "protocol.ext.allow=always", "-c", "protocol.version=2", "clone", "-q", url, cwd],
      { env: { GIT_PROTOCOL: "version=2" } },
    );
    await fsck(client, cwd);
    expect(await objectSet(client, cwd)).toEqual(await objectSet(source));
  });
});
