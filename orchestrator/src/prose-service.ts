// concern: orchestrator prose gate
/** Supplies machine identity and rollback policy to the shared prose gate. */

import { readMachineValue } from '../../shared/machine-config.ts'
import {
  type ProseGateField,
  type ProseGateResult,
  proseGate,
} from '../../shared/prose/prose-gate.ts'
import { cachedSignedInRecordUser } from './record/record-session.ts'

export function proseCheckEnabled(): boolean {
  return readMachineValue('prose.check') !== 'off'
}

export async function orchestratorProseGate(fields: ProseGateField[]): Promise<ProseGateResult> {
  try {
    return proseGate(fields, {
      displayName: cachedSignedInRecordUser()?.name ?? null,
      enabled: proseCheckEnabled(),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      refusal: null,
      notices: [`Spelling and grammar check did not run: ${detail}`],
    }
  }
}

function emitProseNotices(notices: readonly string[]): void {
  for (const notice of notices) console.error(notice)
}

export async function assertOrchestratorProse(fields: ProseGateField[]): Promise<string[]> {
  const result = await orchestratorProseGate(fields)
  if (result.refusal) throw new Error(result.refusal)
  emitProseNotices(result.notices)
  return result.notices
}
