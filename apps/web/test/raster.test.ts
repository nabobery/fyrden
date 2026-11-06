// A raster header read from bytes alone: what it says of a file decides whether the file is
// served as an image, so any bytes at all must answer, and a header cut short must not guess.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, previewOf, previewUrl, sniffRaster } from "../app/lib/raster.js";
import { base64, gif, HEADERS, jpeg, png, webpExtended, webpLossy } from "./helpers/raster.js";

const ascii = (text: string) => new TextEncoder().encode(text);
const COMMIT = "c".repeat(40);

/** A file as the contents API answers it. */
function file(path: string, bytes: Uint8Array | null, size = bytes?.length ?? 0) {
  return {
    type: "file" as const,
    path,
    name: path,
    sha: "a".repeat(40),
    mode: "100644",
    size,
    encoding: bytes ? ("base64" as const) : ("none" as const),
    content: bytes ? base64(bytes) : "",
    download_url: `https://fyrden.test/api/repos/ada/demo/raw/${path}?ref=${COMMIT}`,
  };
}

describe("reading a raster header", () => {
  for (const { name, type, make, max } of HEADERS) {
    it(`reads a ${name}'s type and size`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max }), fc.integer({ min: 1, max }), (width, height) => {
          expect(sniffRaster(make(width, height))).toEqual({ type, width, height });
        }),
      );
    });

    it(`does not guess from a ${name} header cut at any length`, () => {
      const whole = make(300, 200);
      for (let cut = 0; cut < whole.length; cut++)
        expect(sniffRaster(whole.subarray(0, cut)), `${cut} bytes`).toBeNull();
    });

    it(`ignores what follows a ${name} header`, () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 64 }), (rest) => {
          const bytes = Uint8Array.from([...make(300, 200), ...rest]);
          expect(sniffRaster(bytes)).toEqual({ type, width: 300, height: 200 });
        }),
      );
    });
  }

  it("answers any bytes, and never a size of nothing", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const found = sniffRaster(bytes);
        if (found) {
          expect(found.width).toBeGreaterThan(0);
          expect(found.height).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("answers any bytes that follow a real signature", () => {
    const signatures = HEADERS.map(({ make }) => make(300, 200).subarray(0, 12));
    fc.assert(
      fc.property(
        fc.constantFrom(...signatures),
        fc.uint8Array({ maxLength: 512 }),
        (signature, rest) => {
          const found = sniffRaster(Uint8Array.from([...signature, ...rest]));
          if (found) expect(found.width * found.height).toBeGreaterThan(0);
        },
      ),
    );
  });

  it("finds a JPEG's frame after any segments, stopping at the scan", () => {
    const segment = fc.tuple(
      fc.constantFrom(0xe0, 0xe1, 0xe2, 0xdb, 0xc4, 0xc8, 0xcc, 0xfe),
      fc.array(fc.nat(255), { maxLength: 40 }),
    );
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), (segments) => {
        expect(sniffRaster(jpeg(640, 480, 0xc1, segments))).toEqual({
          type: "image/jpeg",
          width: 640,
          height: 480,
        });
      }),
    );
    // The size in what a scan's data holds is not the image's.
    expect(sniffRaster(jpeg(640, 480, 0xc0, [[0xda, [1, 2, 3]]]))).toBeNull();
  });

  it("does not take DHT, JPG or DAC for a frame", () => {
    for (const marker of [0xc4, 0xc8, 0xcc])
      expect(sniffRaster(jpeg(640, 480, marker)), marker.toString(16)).toBeNull();
  });

  it("skips a JPEG's fill bytes and stops at a marker that is not one", () => {
    const whole = jpeg(640, 480);
    expect(sniffRaster(Uint8Array.from([0xff, 0xd8, 0xff, 0xff, ...whole.subarray(2)]))).toEqual({
      type: "image/jpeg",
      width: 640,
      height: 480,
    });
    expect(sniffRaster(Uint8Array.from([0xff, 0xd8, 0x00, ...whole.subarray(2)]))).toBeNull();
    // A segment that says it holds less than its own length field.
    expect(
      sniffRaster(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, ...whole.subarray(2)])),
    ).toBeNull();
  });

  it("refuses a size of nothing", () => {
    for (const bytes of [png(0, 5), png(5, 0), gif(0, 5), gif(5, 0), jpeg(0, 5), jpeg(5, 0)])
      expect(sniffRaster(bytes)).toBeNull();
    expect(sniffRaster(webpLossy(0, 5))).toBeNull();
  });

  it("refuses a PNG size over its format's limit and a first chunk that is not a header", () => {
    expect(sniffRaster(png(0x80000000, 1))).toBeNull();
    const notHeader = png(5, 5);
    notHeader[12] = 0x69;
    expect(sniffRaster(notHeader)).toBeNull();
  });

  it("reads WebP's other sizes only in their own chunk", () => {
    const wrong = webpExtended(5, 5);
    wrong[15] = 0x59;
    expect(sniffRaster(wrong)).toBeNull();
  });

  it("does not take SVG, text or an empty file for an image", () => {
    for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"/>', "plain text\n", "", "GIF8"])
      expect(sniffRaster(ascii(text))).toBeNull();
  });
});

describe("whether a file page shows an image", () => {
  it("up to 1 MiB, goes by the bytes, whatever the name", () => {
    expect(previewOf(file("logo", png(32, 16)), "logo")).toEqual({
      kind: "image",
      commit: COMMIT,
      width: 32,
      height: 16,
    });
    expect(previewOf(file("x.txt", gif(4, 4)), "x.txt")?.kind).toBe("image");
  });

  it("leaves bytes that are no image to the file view, whatever the name", () => {
    expect(previewOf(file("a.png", ascii("<svg/>")), "a.png")).toBeNull();
    expect(previewOf(file("a.txt", ascii("hello")), "a.txt")).toBeNull();
    expect(previewOf(file("empty.png", ascii("")), "empty.png")).toBeNull();
  });

  it("says an image over 16 megapixels is too large, with the limit itself allowed", () => {
    expect(previewOf(file("a.png", png(4000, 4000)), "a.png")?.kind).toBe("image");
    expect(previewOf(file("a.png", png(4000, 4001)), "a.png")).toEqual({
      kind: "image-too-large",
    });
  });

  it("over 1 MiB, tries a raster name up to 4 MiB, in any ASCII case", () => {
    const large = 1024 * 1024 + 1;
    for (const name of ["a.png", "a.JPG", "a.jpeg", "b/a.GiF", "a.webp"])
      expect(previewOf(file(name, null, large), name), name).toEqual({
        kind: "image",
        commit: COMMIT,
        width: null,
        height: null,
      });
    expect(previewOf(file("a.png", null, IMAGE_MAX_BYTES), "a.png")?.kind).toBe("image");
  });

  it("over 1 MiB, reads nothing for any other name, and past 4 MiB for any name", () => {
    const large = 1024 * 1024 + 1;
    for (const name of ["a.svg", "a.txt", "png", "a.png.txt", "a.ſvg", "a.pnG\n"])
      expect(previewOf(file(name, null, large), name), name).toBeNull();
    expect(previewOf(file("a.png", null, IMAGE_MAX_BYTES + 1), "a.png")).toBeNull();
  });

  it("offers nothing without a commit to pin the image to", () => {
    const unpinned = { ...file("a.png", png(1, 1)), download_url: "https://fyrden.test/raw" };
    expect(previewOf(unpinned, "a.png")).toBeNull();
    expect(previewOf({ ...unpinned, download_url: "not a url" }, "a.png")).toBeNull();
  });

  it("names the bytes with a trailing slash, so no name reads as a data request", () => {
    expect(previewUrl("/ada/demo", COMMIT, "dir x/notes.data")).toBe(
      `/ada/demo/preview/${COMMIT}/dir%20x/notes.data/`,
    );
  });
});
