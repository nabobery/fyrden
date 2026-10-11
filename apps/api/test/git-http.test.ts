import { env } from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { AGENT, V2_ONLY_MESSAGE } from "../src/git/protocol.js";
import { basic, createRepo, gitFetch, loadOracleRepo, type TestRepo } from "./helpers/git-http.js";
import {
  asText,
  fromHex,
  LS_REFS_VARIANTS,
  type LsRefsVariant,
  type OracleRepo,
  toHex,
} from "./helpers/git-oracle.js";
import { principalWithToken } from "./helpers/principals.js";

const oracle = inject("gitOracle");

const UPLOAD = "git-upload-pack";
const RECEIVE = "git-receive-pack";
const V2 = { "Git-Protocol": "version=2" };

/** pkt-line payloads as text, with "0000"/"0001"/"0002" for special packets. */
function pktLines(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const length = Number.parseInt(asText(bytes.subarray(at, at + 4)), 16);
    if (length < 4) {
      out.push(asText(bytes.subarray(at, at + 4)));
      at += 4;
    } else {
      out.push(asText(bytes.subarray(at + 4, at + length)));
      at += length;
    }
  }
  return out;
}

const withOurAgent = (lines: string[]) => lines.map((l) => l.replace(oracle.gitAgent, AGENT));

function pkt(line: string): string {
  return (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;
}

function lsRefsBody(args: readonly string[], capabilities = ["object-format=sha1"]): string {
  return [
    pkt("command=ls-refs\n"),
    ...capabilities.map((c) => pkt(`${c}\n`)),
    "0001",
    ...args.map((a) => pkt(`${a}\n`)),
    "0000",
  ].join("");
}

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

let owner: { principalId: string; token: string };
let other: { principalId: string; token: string };
let full: TestRepo;
let empty: TestRepo;
let path: (repo: TestRepo, suffix: string) => string;

beforeAll(async () => {
  owner = await principalWithToken("user", "git");
  other = await principalWithToken("user", "pat");
  const handle = owner.principalId.toLowerCase().replace("_", "-");
  path = (repo, suffix) => `/${handle}/${repo.name}.git${suffix}`;
  full = await createRepo(owner.principalId);
  empty = await createRepo(owner.principalId);
  await loadOracleRepo(full.stub, oracle.full);
});

const auth = () => ({ Authorization: basic(owner.token) });

function lsRefs(repo: TestRepo, args: readonly string[], headers: Record<string, string> = {}) {
  return gitFetch(path(repo, `/${UPLOAD}`), {
    method: "POST",
    headers: {
      "Content-Type": `application/x-${UPLOAD}-request`,
      ...V2,
      ...auth(),
      ...headers,
    },
    body: lsRefsBody(args),
  });
}

describe("authentication and access", () => {
  const endpoints = () => [
    { name: "upload-pack info/refs", url: path(full, `/info/refs?service=${UPLOAD}`), init: {} },
    { name: "receive-pack info/refs", url: path(full, `/info/refs?service=${RECEIVE}`), init: {} },
    {
      name: "upload-pack",
      url: path(full, `/${UPLOAD}`),
      init: {
        method: "POST",
        headers: { "Content-Type": `application/x-${UPLOAD}-request` },
        body: lsRefsBody([]),
      },
    },
    {
      name: "receive-pack",
      url: path(full, `/${RECEIVE}`),
      init: {
        method: "POST",
        headers: { "Content-Type": `application/x-${RECEIVE}-request` },
        body: "0000",
      },
    },
  ];

  const send = (e: ReturnType<typeof endpoints>[number], headers: Record<string, string>) =>
    gitFetch(e.url, {
      ...e.init,
      headers: { ...V2, ...(e.init as { headers?: Record<string, string> }).headers, ...headers },
    });

  it("asks for Basic credentials when no token is sent", async () => {
    for (const e of endpoints()) {
      const res = await send(e, {});
      expect(res.status, e.name).toBe(401);
      expect(res.headers.get("WWW-Authenticate"), e.name).toBe('Basic realm="Fyrden"');
      expect(res.headers.get("Content-Type"), e.name).toMatch(/^text\/plain/);
      expect(await res.text(), e.name).toBe("Authentication required.\n");
    }
  });

  it("rejects a wrong token with a fresh challenge", async () => {
    for (const e of endpoints()) {
      const res = await send(e, { Authorization: basic("fyrden_git_notarealtoken") });
      expect(res.status, e.name).toBe(401);
      expect(res.headers.get("WWW-Authenticate"), e.name).toBe('Basic realm="Fyrden"');
      expect(await res.text(), e.name).toBe("Invalid username or token.\n");
    }
  });

  it("answers another user's repository exactly like a missing one", async () => {
    const handle = owner.principalId.toLowerCase().replace("_", "-");
    for (const e of endpoints()) {
      const theirs = await send(e, { Authorization: basic(other.token) });
      const missing = await send(
        { ...e, url: e.url.replace(full.name, uniqueId("nope")) },
        { Authorization: basic(owner.token) },
      );
      const noOwner = await send(
        { ...e, url: e.url.replace(handle, uniqueId("nobody")) },
        { Authorization: basic(owner.token) },
      );
      for (const res of [theirs, missing, noOwner]) {
        expect(res.status, e.name).toBe(404);
        expect(res.headers.get("WWW-Authenticate"), e.name).toBeNull();
        expect(await res.text(), e.name).toBe("Repository not found.\n");
      }
    }
  });

  it("takes the token from Basic with any user name, or from Bearer", async () => {
    for (const authorization of [
      basic(owner.token, ""),
      basic(owner.token, "someone"),
      `Bearer ${owner.token}`,
    ]) {
      const res = await gitFetch(path(full, `/info/refs?service=${UPLOAD}`), {
        headers: { ...V2, Authorization: authorization },
      });
      expect(res.status, authorization.split(" ")[0]).toBe(200);
    }
  });

  it("accepts personal access tokens and refuses other token types", async () => {
    const pat = await principalWithToken("user", "pat");
    const mine = await createRepo(pat.principalId);
    const handle = pat.principalId.toLowerCase().replace("_", "-");
    const ok = await gitFetch(`/${handle}/${mine.name}/info/refs?service=${UPLOAD}`, {
      headers: { ...V2, Authorization: basic(pat.token) },
    });
    expect(ok.status).toBe(200);

    const run = await principalWithToken("user", "run");
    const theirs = await createRepo(run.principalId);
    const runHandle = run.principalId.toLowerCase().replace("_", "-");
    const refused = await gitFetch(`/${runHandle}/${theirs.name}/info/refs?service=${UPLOAD}`, {
      headers: { ...V2, Authorization: basic(run.token) },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/cannot be used with git/);
  });

  it("hides repositories outside a token's repository list", async () => {
    const limited = await principalWithToken("user", "git");
    const mine = await createRepo(limited.principalId);
    const handle = limited.principalId.toLowerCase().replace("_", "-");
    await env.DIRECTORY.prepare("UPDATE tokens SET repo_ids = ? WHERE principal_id = ?")
      .bind(JSON.stringify(["rep_00000000000000000000000000"]), limited.principalId)
      .run();
    const res = await gitFetch(`/${handle}/${mine.name}/info/refs?service=${UPLOAD}`, {
      headers: { ...V2, Authorization: basic(limited.token) },
    });
    expect(res.status).toBe(404);
  });
});

describe("info/refs", () => {
  it("refuses dumb HTTP and unknown services before authentication", async () => {
    for (const query of ["", "?service=git-upload-archive", "?service=x"]) {
      const res = await gitFetch(path(full, `/info/refs${query}`));
      expect(res.status, query).toBe(403);
      expect(res.headers.get("Content-Type"), query).toMatch(/^text\/plain/);
    }
  });

  it("answers a protocol v0 or v1 upload-pack discovery with an ERR naming protocol v2", async () => {
    for (const header of [undefined, "version=0", "version=1", "version=3"]) {
      const res = await gitFetch(path(full, `/info/refs?service=${UPLOAD}`), {
        headers: header ? { "Git-Protocol": header } : {},
      });
      expect(res.status, header).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(`application/x-${UPLOAD}-advertisement`);
      expect(pktLines(await bytesOf(res))).toEqual([`ERR ${V2_ONLY_MESSAGE}\n`]);
    }
  });

  it("advertises upload-pack v2 as git does, minus the features Fyrden does not serve", async () => {
    const res = await gitFetch(path(full, `/info/refs?service=${UPLOAD}`), {
      headers: { "Git-Protocol": "object-format=sha1:version=2", ...auth() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(`application/x-${UPLOAD}-advertisement`);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, max-age=0, must-revalidate");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(res.headers.get("Expires")).toBe("Fri, 01 Jan 1980 00:00:00 GMT");
    const git = withOurAgent(pktLines(fromHex(oracle.uploadPackV2)))
      .filter((line) => line !== "server-option\n")
      .map((line) => (line.startsWith("fetch=") ? "fetch=shallow\n" : line));
    expect(pktLines(await bytesOf(res))).toEqual(git);
  });

  it("serves the same repository with or without .git, ignoring the case of names", async () => {
    const handle = owner.principalId.toLowerCase().replace("_", "-");
    for (const url of [
      `/${handle}/${full.name}/info/refs?service=${UPLOAD}`,
      `/${handle.toUpperCase()}/${full.name.toUpperCase()}.git/info/refs?service=${UPLOAD}`,
    ]) {
      const res = await gitFetch(url, { headers: { ...V2, ...auth() } });
      expect(res.status, url).toBe(200);
    }
  });

  const receive = async (repo: TestRepo, protocol?: string) => {
    const res = await gitFetch(path(repo, `/info/refs?service=${RECEIVE}`), {
      headers: { ...auth(), ...(protocol ? { "Git-Protocol": protocol } : {}) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(`application/x-${RECEIVE}-advertisement`);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, max-age=0, must-revalidate");
    return pktLines(await bytesOf(res));
  };
  const preamble = [`# service=${RECEIVE}\n`, "0000"];

  it.each([
    ["empty", () => empty, () => oracle.empty],
    ["with refs", () => full, () => oracle.full],
  ])("advertises receive-pack refs as git does (%s)", async (_, repo, git) => {
    const v0 = withOurAgent(pktLines(fromHex(git().receivePackV0)));
    const v1 = withOurAgent(pktLines(fromHex(git().receivePackV1)));
    expect(v1[0]).toBe("version 1\n");
    expect(await receive(repo())).toEqual([...preamble, ...v0]);
    expect(await receive(repo(), "version=1")).toEqual([...preamble, ...v1]);
    // Protocol v2 has no push: git falls back to v0, and so does Fyrden.
    expect(await receive(repo(), "version=2")).toEqual([...preamble, ...v0]);
  });
});

describe("upload-pack ls-refs", () => {
  const variants = Object.keys(LS_REFS_VARIANTS) as LsRefsVariant[];
  const repos: [string, () => TestRepo, () => OracleRepo][] = [
    ["with refs", () => full, () => oracle.full],
    ["empty", () => empty, () => oracle.empty],
  ];

  for (const [label, repo, git] of repos) {
    it.each(variants)(`answers byte for byte as git does (${label}, %s)`, async (variant) => {
      const res = await lsRefs(repo(), LS_REFS_VARIANTS[variant]);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(`application/x-${UPLOAD}-result`);
      expect(res.headers.get("Cache-Control")).toBe("no-cache, max-age=0, must-revalidate");
      const body = await bytesOf(res);
      expect(pktLines(body)).toEqual(pktLines(fromHex(git().lsRefs[variant])));
      expect(toHex(body)).toBe(git().lsRefs[variant]);
    });
  }

  it("peels annotated tags, tags of tags and tags of blobs and trees", async () => {
    const lines = pktLines(await bytesOf(await lsRefs(full, ["peel", "ref-prefix refs/tags/"])));
    expect(lines.filter((l) => l.includes(" peeled:"))).toHaveLength(4);
    expect(lines.find((l) => l.includes("refs/tags/light"))).not.toContain("peeled:");
  });

  it("accepts a gzip-compressed request, as git sends above 1,024 bytes", async () => {
    const body = gzipSync(Buffer.from(lsRefsBody(LS_REFS_VARIANTS.lsRemote)));
    const res = await gitFetch(path(full, `/${UPLOAD}`), {
      method: "POST",
      headers: {
        "Content-Type": `application/x-${UPLOAD}-request`,
        "Content-Encoding": "gzip",
        ...V2,
        ...auth(),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(toHex(await bytesOf(res))).toBe(oracle.full.lsRefs.lsRemote);
  });

  it("refuses a request body that inflates past the limit", async () => {
    const body = gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x30));
    const res = await gitFetch(path(full, `/${UPLOAD}`), {
      method: "POST",
      headers: {
        "Content-Type": `application/x-${UPLOAD}-request`,
        "Content-Encoding": "gzip",
        ...V2,
        ...auth(),
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  // Status 200 throughout: git drops the body of an error status (see gitError).
  it("answers a malformed request with git's error in an ERR packet", async () => {
    for (const [body, message] of [
      [lsRefsBody(["bogus"]), "ERR unexpected line: 'bogus'\n"],
      [lsRefsBody([], ["object-format=sha256"]), /^ERR mismatched object format/],
      [`${pkt("command=frobnicate\n")}0000`, "ERR invalid command 'frobnicate'\n"],
      ["00zz", /^ERR /],
    ] as const) {
      const res = await gitFetch(path(full, `/${UPLOAD}`), {
        method: "POST",
        headers: { "Content-Type": `application/x-${UPLOAD}-request`, ...V2, ...auth() },
        body,
      });
      expect(res.status, body).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(`application/x-${UPLOAD}-result`);
      const [line] = pktLines(await bytesOf(res));
      if (typeof message === "string") expect(line).toBe(message);
      else expect(line).toMatch(message);
    }
  });

  it("ends the session on a lone flush with an empty answer", async () => {
    const res = await gitFetch(path(full, `/${UPLOAD}`), {
      method: "POST",
      headers: { "Content-Type": `application/x-${UPLOAD}-request`, ...V2, ...auth() },
      body: "0000",
    });
    expect(res.status).toBe(200);
    expect((await bytesOf(res)).length).toBe(0);
  });

  it("refuses a request in protocol v0 with the protocol v2 error", async () => {
    const res = await lsRefs(full, [], { "Git-Protocol": "version=1" });
    expect(res.status).toBe(200);
    expect(pktLines(await bytesOf(res))).toEqual([`ERR ${V2_ONLY_MESSAGE}\n`]);
  });

  it("checks the request content type as git http-backend does", async () => {
    const res = await gitFetch(path(full, `/${UPLOAD}`), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...V2, ...auth() },
      body: lsRefsBody([]),
    });
    expect(res.status).toBe(415);
    expect(await res.text()).toBe(
      `Expected POST with Content-Type 'application/x-${UPLOAD}-request', but received 'application/octet-stream' instead.\n`,
    );
  });

  it("answers a fetch without wants with nothing, as git does (fetch itself: fetch.clone.test.ts)", async () => {
    const res = await gitFetch(path(full, `/${UPLOAD}`), {
      method: "POST",
      headers: { "Content-Type": `application/x-${UPLOAD}-request`, ...V2, ...auth() },
      body: `${pkt("command=fetch\n")}0001${pkt("done\n")}0000`,
    });
    expect(res.status).toBe(200);
    expect(pktLines(await bytesOf(res))).toEqual([]);
  });
});

describe("receive-pack POST", () => {
  const push = (body: string) =>
    gitFetch(path(full, `/${RECEIVE}`), {
      method: "POST",
      headers: { "Content-Type": `application/x-${RECEIVE}-request`, ...auth() },
      body,
    });
  const command = (caps: string) =>
    pkt(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/new\0${caps}\n`);

  it("answers a lone flush with an empty result", async () => {
    const res = await push("0000");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(`application/x-${RECEIVE}-result`);
    expect((await bytesOf(res)).length).toBe(0);
  });

  it("reports a pack it cannot read as an unpack error (status 200)", async () => {
    const res = await push(`${command("report-status")}0000PACK`);
    expect(res.status).toBe(200);
    expect(pktLines(await bytesOf(res))).toEqual([
      "unpack index-pack abnormal exit\n",
      "ng refs/heads/new unpacker error\n",
      "0000",
    ]);
  });

  it("sends a malformed request's error on side-band 3 when the push asked for side-band", async () => {
    for (const caps of ["report-status side-band-64k", "side-band agent=git/2.53.0"]) {
      const res = await push(`${command(caps)}${pkt("not a command\n")}0000PACK`);
      expect(res.status).toBe(200);
      const lines = pktLines(await bytesOf(res));
      expect(lines[0]?.startsWith("\u0003protocol error: ")).toBe(true);
      expect(lines.at(-1)).toBe("0000");
    }
  });

  it("checks the request content type", async () => {
    const res = await gitFetch(path(full, `/${RECEIVE}`), {
      method: "POST",
      headers: { "Content-Type": `application/x-${UPLOAD}-request`, ...auth() },
      body: "0000",
    });
    expect(res.status).toBe(415);
  });
});
