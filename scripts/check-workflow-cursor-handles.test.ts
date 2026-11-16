import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bareWorkflowCursorHandles } from './check-workflow-cursor-handles.ts'

test('rejects a production template with a bare workflow cursor handle', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-handle-guard-'))
  const source = join(root, 'orchestrator/src/example')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'bare.ts'),
    'const command = `workflow abandon --cursor $' + '{cursor}`\n',
  )

  expect(bareWorkflowCursorHandles(root)).toEqual([
    'orchestrator/src/example/bare.ts:1: route cursor handles through workflowCursorReference',
  ])
})

test('admits only the exact context holder cursor exemption', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-handle-guard-'))
  const source = join(root, 'orchestrator/src/session')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'context-review.ts'),
    [
      "  if (reference.kind === 'cursor') return `--cursor ${shellQuote(reference.key)}`",
      'const command = `workflow abandon --cursor ${cursor}`',
      '',
    ].join('\n'),
  )

  expect(bareWorkflowCursorHandles(root)).toEqual([
    'orchestrator/src/session/context-review.ts:2: route cursor handles through workflowCursorReference',
  ])
})
