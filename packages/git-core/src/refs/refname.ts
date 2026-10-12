/**
 * git's `check_refname_format` (refs.c, v2.53.0) without its refspec-pattern
 * and sanitising modes. A ref name is rejected if it:
 * - has an empty component (leading, trailing or doubled '/'),
 * - has a component that starts with '.' or ends with ".lock",
 * - contains "..", "@{", a control character, DEL, space, ':', '?', '[',
 *   '\\', '^', '~' or '*',
 * - ends with '.', or is exactly "@",
 * - has one component, unless `allowOneLevel` (for "HEAD").
 * Bytes 0x80 and above are allowed.
 */
export function isValidRefname(
  name: Uint8Array,
  options: { allowOneLevel?: boolean } = {},
): boolean {
  if (name.length === 1 && name[0] === AT) return false;
  const components = countComponents(name);
  return components >= 2 || (components === 1 && options.allowOneLevel === true);
}

/**
 * Whether `prefix + name` is a valid ref name, for a prefix of valid
 * components ending in '/' (such as "refs/tags/"), checked over `name`
 * alone: the rules apply per component, so nothing is joined or copied.
 */
export function isValidRefnameBelowPrefix(name: Uint8Array): boolean {
  return countComponents(name) >= 1;
}

/** The number of components of `name`, or 0 if a component or the last byte is not allowed. */
function countComponents(name: Uint8Array): number {
  let components = 0;
  let start = 0;
  for (;;) {
    const end = componentEnd(name, start);
    if (end <= start) return 0;
    components++;
    if (end === name.length) break;
    start = end + 1;
  }
  return name[name.length - 1] === DOT ? 0 : components;
}

const DOT = 0x2e;
const AT = 0x40;
const SLASH = 0x2f;
const LOCK = [DOT, 0x6c, 0x6f, 0x63, 0x6b]; // ".lock"

/** Bytes git refuses anywhere in a ref name (disposition 4 and 5). */
function isForbidden(c: number): boolean {
  return (
    c < 0x20 ||
    c === 0x7f ||
    c === 0x20 ||
    c === 0x3a || // :
    c === 0x3f || // ?
    c === 0x5b || // [
    c === 0x5c || // \
    c === 0x5e || // ^
    c === 0x7e || // ~
    c === 0x2a // *
  );
}

/** The end of the component starting at `start`, or -1 if it is not allowed. */
function componentEnd(name: Uint8Array, start: number): number {
  let last = 0;
  let i = start;
  for (; i < name.length && name[i] !== SLASH; i++) {
    const c = name[i] as number;
    // git would read the name only up to a NUL, so a name holding one is refused.
    if (c === 0 || isForbidden(c)) return -1;
    if (c === DOT && last === DOT) return -1;
    if (c === 0x7b && last === AT) return -1; // "@{"
    last = c;
  }
  if (i === start) return start;
  if (name[start] === DOT) return -1;
  if (i - start >= LOCK.length && LOCK.every((b, k) => name[i - LOCK.length + k] === b)) return -1;
  return i;
}
