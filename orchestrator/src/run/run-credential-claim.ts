// concern: run credential claim columns
/** Projects one launch credential resolution into the atomic run claim values. */

import type { SQLQueryBindings } from 'bun:sqlite'

export type CredentialPayment = {
  credentialId: string
  payer: 'personal' | 'shared'
  binding: 'space' | 'project'
}

export function endpointKeyIdentityBindings(
  identityColumns: readonly SQLQueryBindings[],
  source: 'agent' | 'project',
  credential: CredentialPayment | null | undefined,
): SQLQueryBindings[] {
  return [
    ...identityColumns,
    source,
    credential?.credentialId ?? null,
    credential?.payer ?? null,
    credential?.binding ?? null,
  ]
}
