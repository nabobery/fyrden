// An image's bytes for the file page: read through the API as the viewer, served only when
// their own header says they are a raster image within limits, and never read past them.

import fc from "fast-check";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePreview } from "../app/components/file-preview.js";
import { IMAGE_MAX_BYTES, SNIFF_MAX_BYTES } from "../app/lib/raster.js";
import { loader as blobLoader } from "../app/routes/repo.blob.js";
import { loader } from "../app/routes/repo.preview.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { base64, chunked, gif, jpeg, png } from "./helpers/raster.js";

const URL_PATH = "/ada/demo/preview/main/a.png/";

function get(answer: () => Response, path = URL_PATH) {
  const { context, calls } = fakeApi(answer);
  const request = new Request(`${ORIGIN}${path}`, { headers: { Cookie: "s=viewer" } });
  const response = loader({
    request,
    context,
    params: { owner: "ada", repo: "demo", ref: "main", "*": "a.png" },
    // biome-ignore lint/suspicious/noExplicitAny: the generated argument's other fields go unread
  } as any);
  return { response, calls };
}

/** Bytes that start with `head` and fill `length`. */
function filled(head: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set(head);
  return bytes;
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

function expectGuarded(response: Response) {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'; sandbox",
  );
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}

describe("an image's bytes", () => {
  it("reaches the raw API as the viewer, and serves the type the bytes say", async () => {
    const image = png(4, 4);
    const { response, calls } = get(
      () =>
        new Response(image, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment",
          },
        }),
      "/ada/demo/preview/main/a.jpg/",
    );
    const served = await response;
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(served.headers.has("Content-Disposition")).toBe(false);
    expectGuarded(served);
    expect(await bytesOf(served)).toEqual(image);
    const call = calls[0];
    expect(new URL(call?.url ?? "").pathname).toBe("/api/repos/ada/demo/raw/a.jpg");
    expect(new URL(call?.url ?? "").searchParams.get("ref")).toBe("main");
    expect(call?.headers.get("Cookie")).toBe("s=viewer");
    expect(call?.headers.get("X-Fyrden-Session")).toBe("1");
  });

  it("reads a name ending in .data as that name, through its trailing slash", async () => {
    const { response, calls } = get(
      () => new Response(gif(1, 1)),
      "/ada/demo/preview/main/dir/notes.data/",
    );
    expect((await response).status).toBe(200);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/repos/ada/demo/raw/dir/notes.data");
  });

  it("refuses SVG named as an image, cancelling its body", async () => {
    let cancelled = false;
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const { response } = get(
      () =>
        new Response(
          // More than one read's worth, so the stream is still open when refused.
          chunked(filled(svg, SNIFF_MAX_BYTES * 2), [1024], () => {
            cancelled = true;
          }),
        ),
    );
    const refused = await response;
    expect(refused.status).toBe(415);
    expect(refused.body).toBeNull();
    expect(refused.headers.get("Content-Type")).toBeNull();
    expectGuarded(refused);
    expect(cancelled).toBe(true);
  });

  it("refuses an image over 16 megapixels and allows exactly that", async () => {
    let cancelled = false;
    const over = get(
      () =>
        new Response(
          chunked(filled(png(4000, 4001), SNIFF_MAX_BYTES * 2), [SNIFF_MAX_BYTES], () => {
            cancelled = true;
          }),
        ),
    );
    expect((await over.response).status).toBe(415);
    expect(cancelled).toBe(true);
    expect((await get(() => new Response(png(4000, 4000))).response).status).toBe(200);
  });

  it("refuses a Content-Length over 4 MiB unread, and allows exactly that", async () => {
    let cancelled = false;
    let reads = 0;
    const stream = chunked(
      png(4, 4),
      [],
      () => {
        cancelled = true;
      },
      () => {
        reads += 1;
      },
    );
    const { response } = get(
      () => new Response(stream, { headers: { "Content-Length": String(IMAGE_MAX_BYTES + 1) } }),
    );
    expect((await response).status).toBe(415);
    expect(cancelled).toBe(true);
    expect(reads).toBe(0);

    const allowed = get(
      () =>
        new Response(filled(png(4, 4), IMAGE_MAX_BYTES), {
          headers: { "Content-Length": String(IMAGE_MAX_BYTES) },
        }),
    );
    const served = await allowed.response;
    expect(served.status).toBe(200);
    expect((await bytesOf(served)).length).toBe(IMAGE_MAX_BYTES);
  });

  it("passes on a failure's status with no body, as after revoked access", async () => {
    for (const status of [401, 403, 404, 422, 500]) {
      const { response } = get(() => json({ code: "secret", detail: "private detail" }, status));
      const failed = await response;
      expect(failed.status).toBe(status);
      expect(await failed.text()).toBe("");
      expect(failed.headers.get("Content-Type")).toBeNull();
      expectGuarded(failed);
    }
    const limited = await get(() => json({}, 429, { "Retry-After": "7" })).response;
    expect(limited.headers.get("Retry-After")).toBe("7");
  });

  it("gives up looking for a header at 256 KiB, however the chunks fall", async () => {
    // A JPEG whose frame starts past the limit, after a chain of comment segments.
    const comment = [0xfe, new Array(0xfff0).fill(0)] as const;
    const late = jpeg(
      10,
      10,
      0xc0,
      Array.from({ length: 5 }, () => comment),
    );
    expect(late.length).toBeGreaterThan(SNIFF_MAX_BYTES);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: SNIFF_MAX_BYTES * 2 }), { maxLength: 8 }),
        async (sizes) => {
          let cancelled = false;
          const { response } = get(
            () =>
              new Response(
                chunked(filled(late, late.length + 1024), sizes, () => {
                  cancelled = true;
                }),
              ),
          );
          const refused = await response;
          expect(refused.status).toBe(415);
          expect(cancelled || sizes.reduce((a, b) => a + b, 0) >= late.length + 1024).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("finds a header within the limit in a single large first chunk", async () => {
    const { response } = get(() => new Response(filled(png(4, 4), SNIFF_MAX_BYTES * 2)));
    expect((await response).status).toBe(200);
  });

  it("keeps every byte in order over arbitrary chunks up to the limit", async () => {
    const whole = filled(gif(4, 4), 300_000).map((byte, at) => (at < 10 ? byte : at % 251));
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 80_000 }), { maxLength: 12 }),
        async (sizes) => {
          const served = await get(() => new Response(chunked(whole, sizes))).response;
          expect(served.status).toBe(200);
          // Compared as one value: an element-wise matcher takes seconds on this many bytes.
          expect(Buffer.compare(await bytesOf(served), whole)).toBe(0);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("stops the stream past 4 MiB and cancels upstream, whatever Content-Length said", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 1024 * 1024 }), { maxLength: 8 }),
        fc.constantFrom<string | null>(null, "1024", "nonsense", "-1"),
        async (sizes, claimed) => {
          let reason: unknown;
          const total = IMAGE_MAX_BYTES + 1;
          const upstream = chunked(filled(png(4, 4), total), sizes, (why) => {
            reason = why ?? "cancelled";
          });
          const headers: Record<string, string> =
            claimed === null ? {} : { "Content-Length": claimed };
          const answer = await get(() => new Response(upstream, { headers })).response;
          if (answer.status === 415) {
            // A chunk so large that the read for the header passed the limit: no byte left.
            expect(answer.body).toBeNull();
            expect(reason).toBeDefined();
            return;
          }
          expect(answer.status).toBe(200);
          const reader = answer.body?.getReader();
          let sent = 0;
          const ended = await (async () => {
            for (;;) {
              const step = await reader?.read();
              if (!step || step.done) return "finished";
              sent += step.value.length;
            }
          })().catch((error: unknown) => error);
          expect(ended).toBeInstanceOf(Error);
          expect(sent).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
          expect(reason).toBeDefined();
        },
      ),
      { numRuns: 25 },
    );
  });

  it("refuses a stream ending at exactly the limit plus one in its first read", async () => {
    let cancelled = false;
    const upstream = chunked(filled(png(4, 4), IMAGE_MAX_BYTES + 2), [IMAGE_MAX_BYTES + 1], () => {
      cancelled = true;
    });
    const answer = await get(() => new Response(upstream)).response;
    expect(answer.status).toBe(415);
    expect(cancelled).toBe(true);
  });

  it("cancels upstream when the browser stops reading", async () => {
    let reason: unknown;
    // Past what the header's read holds, so upstream is still open.
    const upstream = chunked(filled(png(4, 4), SNIFF_MAX_BYTES * 2), [SNIFF_MAX_BYTES], (why) => {
      reason = why;
    });
    const served = await get(() => new Response(upstream)).response;
    const reader = served.body?.getReader();
    await reader?.read();
    await reader?.cancel("gone");
    expect(reason).toBe("gone");
  });
});

describe("the file page", () => {
  function contents(path: string, bytes: Uint8Array) {
    return json({
      type: "file",
      path,
      name: path,
      sha: "a".repeat(40),
      mode: "100644",
      size: bytes.length,
      encoding: "base64",
      content: base64(bytes),
      download_url: `${ORIGIN}/api/repos/ada/demo/raw/${path}?ref=${"c".repeat(40)}`,
    });
  }

  async function blob(path: string, bytes: Uint8Array) {
    const { context } = fakeApi(() => contents(path, bytes));
    return blobLoader({
      request: new Request(`${ORIGIN}/ada/demo/blob/main/${path}`),
      context,
      params: { owner: "ada", repo: "demo", ref: "main", "*": path },
      // biome-ignore lint/suspicious/noExplicitAny: the generated argument's other fields go unread
    } as any);
  }

  it("carries an image's preview, and none for text", async () => {
    const shown = await blob("logo", png(3, 2));
    expect(shown).toMatchObject({
      preview: { kind: "image", commit: "c".repeat(40), width: 3, height: 2 },
    });
    expect(await blob("a.png", new TextEncoder().encode("text"))).toMatchObject({ preview: null });
  });

  it("shows text as text, though it starts like an image, whatever its name", async () => {
    const words = (text: string) => new TextEncoder().encode(text);
    for (const path of ["a.gif", "a.txt", "a.md"])
      for (const text of ["GIF89a\n\n\n\nwords\n", "GIF89aWORDS and more words\n"])
        expect(await blob(path, words(text)), `${path}: ${text}`).toMatchObject({ preview: null });
    // A whole GIF a browser loads, with no frames and so no NUL: the rule leaves it to Raw.
    const noFrames = Buffer.from("474946383961010101c28101014141414141414141414141413b", "hex");
    expect(await blob("empty.gif", noFrames)).toMatchObject({
      file: { state: "text" },
      preview: null,
    });
  });
});

describe("the preview on the page", () => {
  it("names the file and holds its place with its size", () => {
    const html = renderToString(
      createElement(FilePreview, { src: "/p/a.png/", alt: "a.png", width: 3, height: 2 }),
    );
    expect(html).toContain('src="/p/a.png/"');
    expect(html).toContain('alt="a.png"');
    expect(html).toContain('width="3"');
    expect(html).toContain('height="2"');
  });

  it("leaves its size to the image when it is not known", () => {
    const html = renderToString(
      createElement(FilePreview, { src: "/p/a.png/", alt: "a.png", width: null, height: null }),
    );
    expect(html).not.toContain("width=");
    expect(html).not.toContain("height=");
  });
});
