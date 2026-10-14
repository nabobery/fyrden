import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import {
  ed25519FromSeed,
  ed25519PublicKeyBlob,
  parseSshPublicKey,
  type Signer,
  sshCommitSigner,
  sshFingerprint,
} from "@fyrden/git-core";

/**
 * The platform's signing key: commits the server makes (file writes,
 * generated repositories) are signed with it, as SSH signatures. The
 * Worker secret `SIGNING_KEY` holds its 32-byte Ed25519 seed in base64
 * (`fyrden deploy` sets one); without it, those commits are unsigned. Keys
 * it replaced stay listed in `SIGNING_KEYS_RETIRED` (public key lines, one
 * per line), so commits they signed still verify.
 *
 * Signing and verifying read the variables separately: a malformed
 * `SIGNING_KEY` fails the writes it would sign, never the reads; a key
 * that cannot be read is left out of verification (and logged).
 */
export interface PlatformKey {
  /** `SHA256:...`, as ssh-keygen shows it. */
  readonly fingerprint: string;
  /** `ssh-ed25519 AAAA...` */
  readonly key: string;
  readonly current: boolean;
}

type SigningEnv = { readonly SIGNING_KEY?: string; readonly SIGNING_KEYS_RETIRED?: string };

/** Per isolate, for the variable values they were made from. */
let signerCache: { readonly from: string; readonly value: Promise<Signer | undefined> } | undefined;
let keysCache: { readonly from: string; readonly value: Promise<PlatformKey[]> } | undefined;

/** The signer for commits the server makes; undefined without a key. Throws for a malformed key. */
export function platformSigner(env: object): Promise<Signer | undefined> {
  const seed = (env as SigningEnv).SIGNING_KEY ?? "";
  if (signerCache?.from !== seed) {
    const value = seed
      ? ed25519FromSeed(decodeSeed(seed)).then(sshCommitSigner)
      : Promise.resolve(undefined);
    // A failure is not kept: the next write tries again.
    value.catch(() => {
      if (signerCache?.value === value) signerCache = undefined;
    });
    signerCache = { from: seed, value };
  }
  return signerCache.value;
}

/** The platform's public keys, current first; ones that cannot be read are left out. */
export function platformKeys(env: object): Promise<PlatformKey[]> {
  const vars = env as SigningEnv;
  const from = `${vars.SIGNING_KEY ?? ""}\n${vars.SIGNING_KEYS_RETIRED ?? ""}`;
  if (keysCache?.from !== from) keysCache = { from, value: loadKeys(vars) };
  return keysCache.value;
}

async function loadKeys(vars: SigningEnv): Promise<PlatformKey[]> {
  const log = createLogger({ op: "signing.keys" });
  const keys: PlatformKey[] = [];
  if (vars.SIGNING_KEY) {
    try {
      const pair = await ed25519FromSeed(decodeSeed(vars.SIGNING_KEY));
      keys.push(await keyOf(ed25519PublicKeyBlob(pair.publicKey), true));
    } catch (error) {
      log.error("SIGNING_KEY cannot be read; commits it would sign are refused", { error });
    }
  }
  for (const line of (vars.SIGNING_KEYS_RETIRED ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { keyType, blob } = parseSshPublicKey(line);
      if (keyType !== "ssh-ed25519")
        throw new Error(`a ${keyType} key: only Ed25519 keys sign here`);
      keys.push(await keyOf(blob, false));
    } catch (error) {
      log.error("a line of SIGNING_KEYS_RETIRED is not an Ed25519 public key; left out", { error });
    }
  }
  return keys;
}

async function keyOf(blob: Uint8Array, current: boolean): Promise<PlatformKey> {
  return {
    fingerprint: await sshFingerprint(blob),
    key: `ssh-ed25519 ${btoa(String.fromCharCode(...blob))}`,
    current,
  };
}

function decodeSeed(text: string): Uint8Array {
  return Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
}
