import { expect, test } from 'bun:test'
import {
  auditHostedSecretRows,
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
  expect(counts).toEqual([
    {
      table: 'hub_note',
      column: 'text',
      rule: 'hex-run',
      precision: 'high',
      count: 2,
    },
    {
      table: 'hub_note',
      column: 'text',
      rule: 'provider-prefix',
      precision: 'high',
      count: 2,
    },
  ])
  const rendered = renderHostedSecretAudit(counts)
  expect(rendered).toContain('hub_note\ttext\tprovider-prefix\thigh\t2')
  expect(rendered).not.toContain(SECRET)
  expect(JSON.stringify(counts)).not.toContain(SECRET)
})

test('hosted audit can filter a rule and render identifiers without evidence', () => {
  const cells = [
    {
      table: 'hub_task',
      column: 'body',
      id: '01990000-0000-7000-8000-000000000001',
      createdAt: '2026-11-21T12:00:00.000Z',
      value: `Bearer prose ${SECRET}`,
    },
  ]
  const counts = auditHostedSecretRows(cells, { rule: 'provider-prefix' })
  expect(counts).toEqual([
    {
      table: 'hub_task',
      column: 'body',
      rule: 'provider-prefix',
      precision: 'high',
      count: 1,
    },
  ])
})

test('hosted audit applies the outbox evidence-token exemption', () => {
  const evidence = 'a'.repeat(64)
  expect(auditHostedSecretRows([{ table: 'doc', column: 'body', value: evidence }])).toEqual([])
})

test('hosted audit reports requested columns absent from the record schema', () => {
  expect(renderHostedSecretAudit([])).toBe(
    [
      'unavailable\tquestion\treason',
      'unavailable\tquestion\ttext',
      'unavailable\tworkflow_text_copy\ttext',
    ].join('\n'),
  )
})
