// concern: doc-owner
/** Resolves the stable owner of user-scoped documents in either record mode. */

import { machineId } from '../record/machine-identity.ts'
import { signedInRecordUserId } from '../record/record-attribution.ts'
import { RECORD_SIGN_IN_REMEDY } from '../record/record-auth.ts'
import {
  BOUND_RECORD_WRITE_REFUSAL,
  currentRecordWriteDecision,
} from '../record/record-write-authority.ts'

export async function signedInDocOwner(): Promise<string> {
  switch (currentRecordWriteDecision()) {
    case 'local-authoritative':
      return `operator:${machineId()}`
    case 'refused':
      throw new Error(BOUND_RECORD_WRITE_REFUSAL)
    case 'hosted': {
      const owner = await signedInRecordUserId()
      if (!owner) throw new Error(RECORD_SIGN_IN_REMEDY)
      return owner
    }
  }
}
