import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latin1 } from "../../src/object/bytes.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import {
  type Capability,
  encodeRefAdvertisement,
  encodeV2CapabilityAdvertisement,
  readRefAdvertisement,
  readV2CapabilityAdvertisement,
} from "../../src/protocol/capabilities.js";
import { chompLf, PktLineReader, PktLineStreamReader } from "../../src/protocol/pktline.js";
import {
  encodeReceivePackRequest,
  readReceivePackRequest,
} from "../../src/protocol/receive-pack-request.js";
import {
  demultiplexSideband,
  encodeSideband,
  type SidebandFrame,
} from "../../src/protocol/sideband.js";
import {
  encodeV2CommandRequest,
  parseFetchArgs,
  parseLsRefsArgs,
  readV2CommandRequest,
  type V2Advertised,
  type V2CommandRequest,
} from "../../src/protocol/v2-command.js";
import { createGitSandbox, type GitSandbox, gitBinary } from "../../testing/git-cli.js";
import { bin, chunked, collect, concat, str } from "./helpers.js";

/*
 * git as the oracle. Wrapper scripts tee what a real `git clone`, `git
 * fetch` and `git push` exchange with upload-pack and receive-pack; the
 * readers must parse those bytes and the writers must reproduce them byte
 * for byte, or (for v2 requests, where git's client omits some LFs) get the
 * identical response from git.
 */

let sandbox: GitSandbox;
let root: string;
const SRV = "srv.git";
/** Deterministic packs, so two responses to the same request compare equal. */
const ONE_THREAD = ["-c", "pack.threads=1"];

async function capture(name: string): Promise<{ input: Uint8Array; output: Uint8Array }> {
  return {
    input: new Uint8Array(await readFile(join(root, `${name}-in.bin`))),
    output: new Uint8Array(await readFile(join(root, `${name}-out.bin`))),
  };
}

async function rev(dir: string, what: string): Promise<string> {
  return (await sandbox.git(["-C", dir, "rev-parse", what])).stdout.trim();
}

beforeAll(async () => {
  sandbox = await createGitSandbox();
  root = sandbox.dir;
  for (const [name, service] of [
    ["up", "upload-pack"],
    ["rp", "receive-pack"],
  ] as const) {
    const script = join(root, `${name}.sh`);
    await writeFile(
      script,
      `#!/bin/sh\ntee "${root}/${name}-in.bin" | "${gitBinary}" ${ONE_THREAD.join(" ")} ${service} "$@" | tee "${root}/${name}-out.bin"\n`,
    );
    await chmod(script, 0o755);
  }
  await sandbox.git(["init", "-q", "-b", "main", "work"]);
  for (const n of [1, 2, 3]) {
    await writeFile(join(root, "work", "f"), `line ${n}\n`);
    await sandbox.git(["-C", "work", "add", "f"]);
    await sandbox.git(["-C", "work", "commit", "-q", "-m", `c${n}`]);
    if (n === 1) await sandbox.git(["-C", "work", "tag", "-a", "-m", "v1", "v1"]);
  }
  await sandbox.git(["-C", "work", "branch", "topic", "HEAD~1"]);
  await sandbox.git(["init", "-q", "--bare", "-b", "main", SRV]);
  await sandbox.git(["-C", SRV, "config", "receive.advertisePushOptions", "true"]);
  await sandbox.git(["-C", "work", "push", "-q", `../${SRV}`, "main", "topic", "v1"]);
});
afterAll(() => sandbox.dispose());

describe("advertisements", () => {
  it("reads git's v2 capability advertisement and writes it back byte for byte", async () => {
    const bytes = await sandbox.gitBytes(["upload-pack", "--advertise-refs", SRV], {
      env: { GIT_PROTOCOL: "version=2" },
    });
    const reader = new PktLineReader(bytes);
    const caps = await readV2CapabilityAdvertisement(reader);
    expect(caps.map((c) => c.name)).toEqual(
      expect.arrayContaining(["agent", "ls-refs", "fetch", "object-format"]),
    );
    expect(reader.rest()).toHaveLength(0);
    expect(encodeV2CapabilityAdvertisement(caps)).toEqual(bytes);
  });

  it.each([
    ["v0", undefined],
    ["v1", "version=1"],
    ["v2 requested (receive-pack answers v0)", "version=2"],
  ])(
    "reads git receive-pack's %s advertisement and writes it back byte for byte",
    async (_name, protocol) => {
      const env: Record<string, string> = protocol ? { GIT_PROTOCOL: protocol } : {};
      const bytes = await sandbox.gitBytes(["receive-pack", "--advertise-refs", SRV], { env });
      const parsed = await readRefAdvertisement(new PktLineReader(bytes));
      expect(parsed.version).toBe(protocol === "version=1" ? 1 : 0);
      const refs = (
        await sandbox.git(["-C", SRV, "for-each-ref", "--format=%(objectname) %(refname)"])
      ).stdout;
      expect(parsed.refs.map((r) => `${oidToHex(r.oid)} ${str(r.name)}`)).toEqual(
        refs.trim().split("\n"),
      );
      expect(parsed.capabilities.map((c) => c.name)).toContain("report-status");
      expect(encodeRefAdvertisement(parsed)).toEqual(bytes);
    },
  );

  it("reads an empty repository's advertisement (capabilities^{}) and writes it back", async () => {
    await sandbox.git(["init", "-q", "--bare", "empty.git"]);
    const bytes = await sandbox.gitBytes(["receive-pack", "--advertise-refs", "empty.git"]);
    const parsed = await readRefAdvertisement(new PktLineReader(bytes));
    expect(parsed.refs).toEqual([]);
    expect(encodeRefAdvertisement(parsed)).toEqual(bytes);
  });
});

/** The requests in a captured upload-pack session, each with its own bytes. */
async function splitRequests(
  input: Uint8Array,
  advertised: V2Advertised,
): Promise<{ request: V2CommandRequest; bytes: Uint8Array }[]> {
  const reader = new PktLineReader(input);
  const out: { request: V2CommandRequest; bytes: Uint8Array }[] = [];
  for (;;) {
    const start = reader.offset;
    const request = await readV2CommandRequest(reader, advertised);
    if (!request) break;
    out.push({ request, bytes: input.subarray(start, reader.offset) });
  }
  expect(reader.rest()).toHaveLength(0);
  return out;
}

function advertisedBy(caps: readonly Capability[]): V2Advertised {
  const commands = ["ls-refs", "fetch", "object-info", "bundle-uri"];
  return {
    commands: caps.map((c) => c.name).filter((n) => commands.includes(n)),
    capabilities: caps.map((c) => c.name).filter((n) => !commands.includes(n)),
  };
}

const statelessUploadPack = (input: Uint8Array) =>
  sandbox.gitBytes([...ONE_THREAD, "upload-pack", "--stateless-rpc", SRV], {
    input,
    env: { GIT_PROTOCOL: "version=2" },
  });

describe("a protocol v2 clone and fetch", () => {
  let session: { input: Uint8Array; output: Uint8Array };
  let advertised: V2Advertised;

  beforeAll(async () => {
    await sandbox.git([
      "-c",
      "protocol.version=2",
      "clone",
      "-q",
      "--depth",
      "1",
      `--upload-pack=${root}/up.sh`,
      `file://${root}/${SRV}`,
      "clone",
    ]);
    session = await capture("up");
    advertised = advertisedBy(
      await readV2CapabilityAdvertisement(new PktLineReader(session.output)),
    );
  });

  it("parses every request git's client sent", async () => {
    const requests = await splitRequests(session.input, advertised);
    expect(requests.map((r) => r.request.command)).toEqual(["ls-refs", "fetch"]);
    const lsRefs = parseLsRefsArgs((requests[0] as { request: V2CommandRequest }).request.args);
    expect(lsRefs.symrefs).toBe(true);
    const fetch = parseFetchArgs((requests[1] as { request: V2CommandRequest }).request.args);
    expect(fetch.wants).toEqual([oidFromHex(await rev(SRV, "main"))]);
    expect(fetch.deepen).toBe(1);
    expect(fetch.done).toBe(true);
  });

  it("gets git's response, byte for byte, to each request re-encoded by Fyrden", async () => {
    for (const { request, bytes } of await splitRequests(session.input, advertised)) {
      const ours = encodeV2CommandRequest(request);
      expect(await statelessUploadPack(ours)).toEqual(await statelessUploadPack(bytes));
    }
  });

  it("demultiplexes the packfile section into a pack git can index, and re-frames it byte for byte", async () => {
    const reader = new PktLineReader(session.output);
    await readV2CapabilityAdvertisement(reader);
    // ls-refs response, then the fetch response's sections up to "packfile".
    while (reader.read()?.kind !== "flush") {}
    for (;;) {
      const pkt = reader.read();
      if (pkt?.kind === "data" && latin1(chompLf(pkt.data)) === "packfile") break;
      expect(pkt).toBeDefined();
    }
    const start = reader.offset;
    const frames: SidebandFrame[] = [];
    for await (const frame of demultiplexSideband(reader)) frames.push(frame);
    expect(reader.rest()).toHaveLength(0);
    const reframed = concat(...frames.map((f) => encodeSideband(f.band, f.payload)), bin("0000"));
    expect(reframed).toEqual(session.output.subarray(start));
    const pack = concat(...frames.filter((f) => f.band === 1).map((f) => f.payload));
    expect(str(pack.subarray(0, 4))).toBe("PACK");
    await sandbox.git(["init", "-q", "--bare", "index-check.git"]);
    const indexed = await sandbox.git(["-C", "index-check.git", "index-pack", "--stdin"], {
      input: pack,
    });
    expect(indexed.stdout).toMatch(/^pack\t[0-9a-f]{40}\n$/);
  });

  it("parses a later fetch with haves and shallow lines", async () => {
    await writeFile(join(root, "work", "f"), "line 4\n");
    await sandbox.git(["-C", "work", "commit", "-q", "-am", "c4"]);
    await sandbox.git(["-C", "work", "push", "-q", `../${SRV}`, "main"]);
    await sandbox.git([
      "-C",
      "clone",
      "-c",
      "protocol.version=2",
      "fetch",
      "-q",
      `--upload-pack=${root}/up.sh`,
      "origin",
    ]);
    const requests = await splitRequests((await capture("up")).input, advertised);
    const fetches = requests
      .filter((r) => r.request.command === "fetch")
      .map((r) => parseFetchArgs(r.request.args));
    expect(fetches.length).toBeGreaterThan(0);
    const last = fetches[fetches.length - 1];
    expect(last?.shallow.length).toBe(1);
    expect(fetches.some((f) => f.haves.length > 0)).toBe(true);
    for (const { request, bytes } of requests) {
      expect(await statelessUploadPack(encodeV2CommandRequest(request))).toEqual(
        await statelessUploadPack(bytes),
      );
    }
  });
});

describe("a push", () => {
  it("parses git's push from a shallow clone and reproduces the request byte for byte", async () => {
    await writeFile(join(root, "clone", "g"), "pushed\n");
    await sandbox.git(["-C", "clone", "add", "g"]);
    await sandbox.git(["-C", "clone", "commit", "-q", "-m", "from shallow"]);
    const shallow = (await readFile(join(root, "clone", ".git", "shallow"), "utf8"))
      .trim()
      .split("\n");
    await sandbox.git([
      "-C",
      "clone",
      "push",
      "-q",
      `--receive-pack=${root}/rp.sh`,
      "-o",
      "ci.skip",
      "-o",
      "note=two words",
      "origin",
      "HEAD:refs/heads/pushed",
    ]);
    const { input, output } = await capture("rp");

    const reader = new PktLineStreamReader(chunked(input, [7, 100, 101, input.length - 30]));
    const request = await readReceivePackRequest(reader, { pushOptionsAdvertised: true });
    const pack = await collect(reader.rest());
    expect(request.shallow.map(oidToHex)).toEqual(shallow);
    expect(
      request.commands.map((c) => [oidToHex(c.oldOid), oidToHex(c.newOid), str(c.refName)]),
    ).toEqual([["0".repeat(40), await rev("clone", "HEAD"), "refs/heads/pushed"]]);
    expect(request.pushOptions?.map(str)).toEqual(["ci.skip", "note=two words"]);
    expect(request.capabilities.map((c) => c.name)).toContain("side-band-64k");
    expect(str(pack.subarray(0, 4))).toBe("PACK");
    expect(concat(encodeReceivePackRequest(request), pack)).toEqual(input);

    // receive-pack's answer: the advertisement, then report-status inside side-band 1.
    const out = new PktLineReader(output);
    await readRefAdvertisement(out);
    const start = out.offset;
    const frames: SidebandFrame[] = [];
    for await (const frame of demultiplexSideband(out)) frames.push(frame);
    expect(concat(...frames.map((f) => encodeSideband(f.band, f.payload)), bin("0000"))).toEqual(
      output.subarray(start),
    );
    const report = new PktLineReader(
      concat(...frames.filter((f) => f.band === 1).map((f) => f.payload)),
    );
    const lines: string[] = [];
    for (let pkt = report.read(); pkt?.kind === "data"; pkt = report.read())
      lines.push(str(chompLf(pkt.data)));
    expect(lines).toEqual(["unpack ok", "ok refs/heads/pushed"]);
  });

  it("git receive-pack accepts a request Fyrden writes", async () => {
    const old = await rev(SRV, "main");
    await writeFile(join(root, "work", "f"), "line 5\n");
    await sandbox.git(["-C", "work", "commit", "-q", "-am", "c5"]);
    const next = await rev("work", "HEAD");
    const pack = await sandbox.gitBytes(
      ["-C", "work", "pack-objects", "--stdout", "--revs", "-q"],
      {
        input: `${next}\n^${old}\n`,
      },
    );
    const request = encodeReceivePackRequest({
      shallow: [],
      commands: [
        { oldOid: oidFromHex(old), newOid: oidFromHex(next), refName: bin("refs/heads/main") },
      ],
      capabilities: [
        { name: "report-status" },
        { name: "side-band-64k" },
        { name: "object-format", value: "sha1" },
        { name: "agent", value: "fyrden/test" },
      ],
      pushOptions: undefined,
    });
    const response = await sandbox.gitBytes(["receive-pack", "--stateless-rpc", SRV], {
      input: concat(request, pack),
    });
    const frames: SidebandFrame[] = [];
    for await (const frame of demultiplexSideband(new PktLineReader(response))) frames.push(frame);
    const report = str(concat(...frames.filter((f) => f.band === 1).map((f) => f.payload)));
    expect(report).toContain("unpack ok");
    expect(report).toContain("ok refs/heads/main");
    expect(await rev(SRV, "main")).toBe(next);
  });
});
