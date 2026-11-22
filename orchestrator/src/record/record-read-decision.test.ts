import { describe, expect, test } from 'bun:test'
import { decideRecordRead } from './record-read-decision.ts'

const input = {
  recordApiConfigured: false,
  installBound: false,
  boundOrigin: null,
  resolvedOrigin: 'https://record.example',
  machineJoined: false as boolean | 'unreadable',
  localByDesign: false,
  discardStore: false,
  storeOverride: false,
}

describe('decideRecordRead', () => {
  test('selects hosted for an explicitly configured record', () => {
    expect(decideRecordRead({ ...input, recordApiConfigured: true })).toEqual({
      verdict: 'hosted',
    })
  })

  test('selects local for a local-only install', () => {
    expect(decideRecordRead(input)).toEqual({ verdict: 'local-authoritative' })
  })

  test('refuses a joined machine whose store is unbound', () => {
    expect(decideRecordRead({ ...input, machineJoined: true })).toMatchObject({
      verdict: 'refused',
      refusal: expect.stringContaining('record use <address>'),
    })
  })
})
