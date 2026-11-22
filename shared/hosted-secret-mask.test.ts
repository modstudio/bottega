import { expect, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import {
  HOSTED_SECRET_TABLES,
  maskHostedTableWrite,
  withHostedMaskWarnings,
} from './hosted-secret-mask.ts'
import { redactSecretShaped } from './secret-shaped.ts'

const token = 'ghp_123456789012345678901234567890123456'
const masked = redactSecretShaped(token, { precision: 'high' }).text

const cases = [
  ['hub_note', 'text', 'project'],
  ['hub_task', 'title', 'key'],
  ['hub_task_comment', 'body', 'taskKey'],
  ['hub_task_document', 'title', 'version'],
  ['context_item', 'body', 'slug'],
  ['question', 'question', 'workflowKey'],
  ['workflow_step_text', 'body', 'stepSlug'],
  ['workflow_version', 'definition', 'status'],
  ['workflow_event', 'reason', 'event'],
  ['step_catalogue_version', 'definition', 'status'],
  ['step_catalogue_event', 'reason', 'event'],
  ['doc', 'title', 'slug'],
  ['doc_revision', 'author', 'scope'],
] as const

test.each(cases)('%s masks a free-text column and preserves an excluded column', (table, free, excluded) => {
  const result = maskHostedTableWrite(table, { [free]: token, [excluded]: token }) as Record<string, unknown>
  expect(result[free]).toBe(masked)
  expect(result[excluded]).toBe(token)
})

test('jsonb masks undeclared free-text leaves while preserving structured names', () => {
  expect(maskHostedTableWrite('hub_note', { anchors: [{ addedLater: token, projectId: token }] })).toEqual({
    anchors: [{ addedLater: masked, projectId: token }],
  })
})

test('generic matches remain byte-identical and warnings name only rule and column path', async () => {
  const generic = 'a key=value line with bearer prose and VGhpcyBpcyBhIGdlbmVyaWMgcHJvc2Ugc2FtcGxl'
  const response = await withHostedMaskWarnings(async () => {
    expect(maskHostedTableWrite('hub_task', { title: token, body: generic })).toEqual({ title: masked, body: generic })
    return new Response('ok')
  })
  expect(response.headers.get('warning')).toContain('hub_task.title (provider-prefix)')
  expect(response.headers.get('warning')).not.toContain(token)
})

test('board tables remain refusal-only', () => {
  const board = HOSTED_SECRET_TABLES.filter(({ mask }) => !mask)
  expect(board).toHaveLength(2)
  for (const entry of board)
    expect(() => maskHostedTableWrite(getTableName(entry.table), {})).toThrow('uses refusal')
})
