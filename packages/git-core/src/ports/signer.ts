/**
 * Signs commits the server creates (file writes, merges). The payload is
 * the commit as encoded without its signature; the answer is the text of
 * its `gpgsig` header (an armored SSH or OpenPGP signature).
 */
export interface Signer {
  /**
   * Names the key it signs with, for work that must sign everything it
   * makes with one key (a commit sequence made over several steps).
   */
  readonly keyId?: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}
