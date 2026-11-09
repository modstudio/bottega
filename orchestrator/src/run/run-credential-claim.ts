// concern: run credential claim columns
/** Projects one launch credential resolution into the atomic run claim values. */

export type CredentialPayment = {
  credentialId: string
  payer: 'personal' | 'shared'
  binding: 'space' | 'project'
}

export function endpointKeyIdentityBindings(
  identityColumns: readonly unknown[],
  source: 'agent' | 'project',
  credential: CredentialPayment | null | undefined,
): unknown[] {
  return [
    ...identityColumns,
    source,
    credential?.credentialId ?? null,
    credential?.payer ?? null,
    credential?.binding ?? null,
  ]
}
