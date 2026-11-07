/** What RFC 8187 lets stand for itself in an extended value; every other byte is `%HH`. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * The header that saves `name` under that name (RFC 6266): `filename*` holds
 * it exactly, and `filename` an ASCII fallback for a client that doesn't read
 * the other. Every byte outside plain printable ASCII is replaced or encoded,
 * so no name can add a header or a parameter. The fallback loses `%` too,
 * since some clients decode it there (RFC 6266 appendix D).
 */
export function contentDispositionFor(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/gu, "_");
  let exact = "";
  // Encoded byte by byte, as encodeURIComponent would throw on a lone surrogate.
  for (const byte of new TextEncoder().encode(name)) {
    const char = String.fromCharCode(byte);
    exact += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}
