import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ACP_PARITY_REPOSITORY_ROOT, caseSemanticallyMatches, requiredParityPassed, type Row,
  parityCaseVerdict,
} from './acp-parity.ts'

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
  test('resolves repository-read paths from the script instead of the process cwd', () => {
    expect(ACP_PARITY_REPOSITORY_ROOT).toBe(resolve(import.meta.dir, '../..'))
    expect(existsSync(join(ACP_PARITY_REPOSITORY_ROOT, 'orchestrator/package.json'))).toBe(true)
    expect(existsSync(join(ACP_PARITY_REPOSITORY_ROOT, 'orchestrator/src/agents.ts'))).toBe(true)
  })

  test('requires each successful transport turn to contain its declared semantic answer', () => {
    const reply = (output: string, stopReason: string | null = 'end_turn') => ({
      output, parsed: { text: output, tokens: null, costUsd: null }, stopReason,
    })
    expect(caseSemanticallyMatches('tool-read', reply('path does not exist'))).toBe(false)
    expect(caseSemanticallyMatches('tool-read', reply('@devbox/orchestrator'))).toBe(true)
    expect(parityCaseVerdict('tool-read', 'ok', null, reply('path does not exist')))
      .toEqual({ outcome: 'failed', failureKind: 'semantic' })
    expect(parityCaseVerdict('tool-read', 'ok', null, reply('@devbox/orchestrator')))
      .toEqual({ outcome: 'ok', failureKind: '—' })
    expect(caseSemanticallyMatches('structured-ok', reply('{"status":"wrong"}'))).toBe(false)
    expect(caseSemanticallyMatches('schema', reply('{"verdict":"true"}'))).toBe(true)
    expect(caseSemanticallyMatches('malformed', reply('{'))).toBe(true)
    expect(caseSemanticallyMatches('timeout', reply('', 'timeout'))).toBe(true)
  })

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

  test('rejects a semantically wrong response even when its transport completed', () => {
    const wrong = passingRows()
    wrong[2] = row('tool-read', 'cli', 'failed', 'semantic')
    expect(requiredParityPassed(wrong)).toBe(false)
  })
})
