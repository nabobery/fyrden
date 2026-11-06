/**
 * The session cookie's name. `__Host-`: set by this origin only, over HTTPS,
 * for every path. Its own entry, so the web Worker can read it without
 * bundling the operation registry.
 */
export const SESSION_COOKIE = "__Host-fyrden_session";
