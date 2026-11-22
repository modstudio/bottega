import { expect, test } from 'bun:test'
import {
  auditHostedSecretRows,
  HOSTED_SECRET_AUDIT_UNAVAILABLE_COLUMNS,
  renderHostedSecretAudit,
} from './hosted-secret-audit.ts'

const SECRET = 'ghp_123456789012345678901234567890123456'

test('hosted audit counts table x column x rule without retaining evidence', () => {
  const counts = auditHostedSecretRows([
    { table: 'hub_note', column: 'text', value: `first ${SECRET}` },
    { table: 'hub_note', column: 'text', value: `second ${SECRET}` },
    { table: 'hub_note', column: 'area', value: 'clean' },
    { table: 'hub_task', column: 'body', value: null },
  ])
  expect(counts).toEqual([{ table: 'hub_note', column: 'text', rule: 'provider-prefix', count: 2 }])
  const rendered = renderHostedSecretAudit(counts)
  expect(rendered).toContain('hub_note\ttext\tprovider-prefix\t2')
  expect(rendered).not.toContain(SECRET)
  expect(JSON.stringify(counts)).not.toContain(SECRET)
})

test('hosted audit applies the outbox evidence-token exemption', () => {
  const evidence = 'a'.repeat(64)
  expect(auditHostedSecretRows([{ table: 'doc', column: 'body', value: evidence }])).toEqual([])
})

test('hosted audit reports requested columns absent from the record schema', () => {
  expect(HOSTED_SECRET_AUDIT_UNAVAILABLE_COLUMNS).toEqual([
    { table: 'question', column: 'reason' },
    { table: 'question', column: 'text' },
    { table: 'workflow_text_copy', column: 'text' },
  ])
  expect(renderHostedSecretAudit([])).toBe(
    [
      'unavailable\tquestion\treason',
      'unavailable\tquestion\ttext',
      'unavailable\tworkflow_text_copy\ttext',
    ].join('\n'),
  )
})
