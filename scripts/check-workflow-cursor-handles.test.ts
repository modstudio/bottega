import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bareWorkflowCursorHandles,
  unguardedWorkflowCursorOwnerWrites,
} from './check-workflow-cursor-handles.ts'

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

test('rejects a stage owner write that bypasses the cursor owner decision', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-owner-guard-'))
  const source = join(root, 'orchestrator/src/workflow')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'cursor.ts'),
    [
      "const unsafe = { stage: { values: { sessionId: context.session } } }",
      "const safe = { stageInsert: { sessionId: cursorOwnerAfter('compose', null, context.session) } }",
      '',
    ].join('\n'),
  )

  expect(unguardedWorkflowCursorOwnerWrites(root)).toEqual([
    'orchestrator/src/workflow/cursor.ts:1: route stage sessionId through cursorOwnerAfter',
  ])
})
