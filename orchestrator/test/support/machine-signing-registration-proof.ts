import { expect } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigTenant } from '../../src/record/record-config.ts'
import { registerMachineKey } from '../../src/record/record-machine-key-registration.ts'

export async function proveMachineSigningKeyRegistration(
  tenant: ConfigTenant,
  keyId: string,
  publicKey: Uint8Array,
): Promise<void> {
  const signingPublicKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
  const input = {
    ...tenant,
    keyId,
    publicKey,
    signingPublicKey,
    label: 'service machine',
  }

  await expect(registerMachineKey(input)).resolves.toMatchObject({ signingPublicKey })
  await expect(registerMachineKey(input)).resolves.toMatchObject({ signingPublicKey })
  await expect(
    registerMachineKey({
      ...tenant,
      keyId,
      publicKey,
      label: input.label,
    }),
  ).resolves.toMatchObject({ signingPublicKey })
  await expect(
    registerMachineKey({
      ...input,
      signingPublicKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    }),
  ).rejects.toMatchObject({
    status: 409,
    message: `machine key ${keyId} is already registered with a different signing key; have an owner revoke this machine key from an approved machine, then run \`${PLATFORM_SLUG} machine config machine init\` again to replace both keys`,
  })
}
