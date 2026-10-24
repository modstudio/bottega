import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideWorkflowEvidenceRecording,
  workflowEvidenceNotRecordedRefusal,
} from './workflow-evidence-recording.ts'

const decide = (input: {
  openedSchemaVersion: number | null
  storeSchemaVersion: number | null
  compatibility?: 'additive' | 'incompatible'
}) =>
  decideWorkflowEvidenceRecording({
    compatibility: input.compatibility ?? 'incompatible',
    ...input,
  })

describe('workflow evidence recording', () => {
  test('records in this process when the store still holds the opened version', () => {
    expect(
      decide({ openedSchemaVersion: 145, storeSchemaVersion: 145, compatibility: 'incompatible' }),
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

  test('a lost hand-off leads with the wrapped exit code and gives the remedy', () => {
    const line = workflowEvidenceNotRecordedRefusal({ exitCode: 7 })
    expect(line).toStartWith(`${PLATFORM_SLUG} workflow exec: command exited 7`)
    expect(line).toContain('its evidence was not recorded')
    expect(line).toContain('once the store and checkout agree')
    expect(workflowEvidenceNotRecordedRefusal({ exitCode: 0, detail: 'printed no id' })).toContain(
      'not recorded (printed no id)',
    )
  })
})
