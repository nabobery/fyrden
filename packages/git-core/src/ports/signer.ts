/**
 * Signs commits the server creates (file writes, merges). The payload is
 * the commit as encoded without its signature; the answer is the text of
 * its `gpgsig` header (an armored SSH or OpenPGP signature).
 */
export interface Signer {
  sign(payload: Uint8Array): Promise<Uint8Array>;
}
