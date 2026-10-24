import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideWorkflowEvidenceRecording } from './workflow-evidence-recording.ts'

const decide = (input: {
  openedSchemaVersion: number | null
  storeSchemaVersion: number | null
  compatibility?: 'additive' | 'incompatible'
}) =>
  decideWorkflowEvidenceRecording({
    openedSchemaVersion: input.openedSchemaVersion,
    storeSchemaVersion: input.storeSchemaVersion,
    compatibility: () => input.compatibility ?? 'incompatible',
  })

describe('workflow evidence recording', () => {
  // The journal is read and validated only when the store moved forward, so an unreadable
  // journal cannot cost a run whose store never moved its evidence.
  test('records in this process when the store still holds the opened version, without reading the journal', () => {
    expect(
      decideWorkflowEvidenceRecording({
        openedSchemaVersion: 145,
        storeSchemaVersion: 145,
        compatibility: () => {
          throw new Error('the journal must not be read when the versions agree')
        },
      }),
    ).toEqual({ action: 'record' })
  })

  test('records when this process never opened the store, whatever the store holds', () => {
    expect(decide({ openedSchemaVersion: null, storeSchemaVersion: 151 })).toEqual({
      action: 'record',
    })
    expect(decide({ openedSchemaVersion: null, storeSchemaVersion: null })).toEqual({
      action: 'record',
    })
  })

  test('records an additive advance, which exec reloads instead of refusing', () => {
    expect(
      decide({ openedSchemaVersion: 145, storeSchemaVersion: 147, compatibility: 'additive' }),
    ).toEqual({ action: 'record' })
  })

  test('hands an incompatible advance to a process that opens the migrated store', () => {
    expect(
      decide({ openedSchemaVersion: 145, storeSchemaVersion: 146, compatibility: 'incompatible' }),
    ).toEqual({ action: 'hand-off' })
  })

  test('refuses a store behind the opened version, naming both', () => {
    const decision = decide({ openedSchemaVersion: 147, storeSchemaVersion: 145 })
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') throw new Error('expected a refusal')
    expect(decision.reason).toContain('store user_version 145, opened 147')
    expect(decision.reason).toContain(
      `cleared by: re-run the command under ${PLATFORM_SLUG} workflow exec`,
    )
  })
})
