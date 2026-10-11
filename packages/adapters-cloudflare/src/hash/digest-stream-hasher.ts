import type { Hasher } from "@fyrden/git-core";

/**
 * The `Hasher` port over the Workers runtime's `crypto.DigestStream`
 * (developers.cloudflare.com/workers/runtime-apis/web-crypto/). It does not
 * detect SHA-1 collision attacks, so use it only for checksums over a whole
 * stream, such as a pack trailer; object ids are hashed with git-core's
 * `Sha1`, which does. Its state cannot be saved either.
 */
export function createDigestStreamHasher(): Hasher {
  const stream = new crypto.DigestStream("SHA-1");
  const writer = stream.getWriter();
  return {
    update: (chunk) => writer.write(chunk),
    async digest() {
      await writer.close();
      return new Uint8Array(await stream.digest);
    },
  };
}
