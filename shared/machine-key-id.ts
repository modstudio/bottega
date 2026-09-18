const MACHINE_KEY_BYTES = 32

/** Derives the stable persisted id for an X25519 public key. */
export async function machineKeyId(publicKey: Uint8Array): Promise<string> {
  if (publicKey.length !== MACHINE_KEY_BYTES)
    throw new Error('machine public key must be exactly 32 bytes')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(publicKey)))
  return Buffer.from(digest.subarray(0, 16)).toString('base64url')
}
