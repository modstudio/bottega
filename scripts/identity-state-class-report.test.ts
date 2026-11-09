import { describe, expect, test } from 'bun:test'
import { hostedWritePathReport } from './identity-state-class-report.ts'
import type { StateClassDeclaration } from './identity-state-classes.ts'

describe('hostedWritePathReport', () => {
  test('groups hosted tables by their derived write path', () => {
    const declarations: StateClassDeclaration[] = [
      {
        store: 'orchestrator',
        table: 'cached_row',
        class: 'hosted',
        reason: 'Cached hosted rows',
        counterpart: 'cached_row',
        cache: true,
      },
      {
        store: 'orchestrator',
        table: 'outbox_row',
        class: 'hosted',
        reason: 'Rows sent through the outbox',
        counterpart: 'outbox_row',
      },
      {
        store: 'orchestrator',
        table: 'local_row',
        class: 'hosted',
        reason: 'Rows awaiting a hosted home',
        task: 'DEV-2234',
      },
      {
        store: 'orchestrator',
        table: 'direct_row',
        class: 'hosted',
        reason: 'Rows written directly to the hosted record',
        counterpart: 'direct_row',
      },
    ]

    expect(
      hostedWritePathReport(declarations, ['orchestrator.cached_row', 'orchestrator.outbox_row']),
    ).toEqual({
      counts: { direct: 1, outbox: 1, cache: 1, local: 1 },
      paths: {
        direct: ['orchestrator.direct_row'],
        outbox: ['orchestrator.outbox_row'],
        cache: ['orchestrator.cached_row'],
        local: ['orchestrator.local_row'],
      },
    })
  })
})
