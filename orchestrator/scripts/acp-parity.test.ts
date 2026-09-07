import { describe, expect, test } from 'bun:test'
import { requiredParityPassed, type Row } from './acp-parity.ts'

const row = (caseName: string, transport: 'cli' | 'acp', outcome = 'ok', failureKind = '—'): Row => ({
  case: caseName, transport, outcome, failureKind, tokens: '1', latencyMs: 1, rawBytes: 1,
})

function passingRows(): Row[] {
  const rows: Row[] = []
  for (const name of ['structured-ok', 'tool-read', 'schema', 'timeout', 'malformed']) {
    for (const transport of ['cli', 'acp'] as const) {
      rows.push(name === 'timeout'
        ? row(name, transport, 'failed', 'timeout')
        : row(name, transport))
    }
  }
  rows.push(row('ask-answer', 'acp'))
  return rows
}

describe('ACP parity exit verdict', () => {
  test('accepts the complete matrix including the expected timeout failures', () => {
    expect(requiredParityPassed(passingRows())).toBe(true)
  })

  test('rejects a case exception and a failed ask round trip', () => {
    const exception = passingRows()
    exception[0] = row('structured-ok', 'cli', 'failed', 'harness')
    expect(requiredParityPassed(exception)).toBe(false)

    const askFailure = passingRows()
    askFailure[askFailure.length - 1] = row('ask-answer', 'acp', 'failed', 'continuation')
    expect(requiredParityPassed(askFailure)).toBe(false)
  })
})
