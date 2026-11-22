import { expect, test } from 'bun:test'
import { boardMessage, boardMessageTag } from '../../../shared/record/schema-board.ts'
import { contextItem } from '../../../shared/record/schema-context-items.ts'
import { doc, docRevision } from '../../../shared/record/schema-docs.ts'
import { hubNote, hubTask, hubTaskComment, hubTaskDocument } from '../../../shared/record/schema-hub.ts'
import { question } from '../../../shared/record/schema-question.ts'
import { workflowStepText } from '../../../shared/record/schema-task-flow.ts'
import { workflowVersion } from '../../../shared/record/schema-workflow-catalogue.ts'
import {
  auditHostedSecretRows,
  HOSTED_SECRET_AUDIT_SCHEMA,
  HOSTED_SECRET_AUDIT_UNAVAILABLE_COLUMNS,
  renderHostedSecretAudit,
} from './hosted-secret-audit.ts'

const SECRET = 'ghp_123456789012345678901234567890123456'

test('hosted audit table, free-text, and timestamp columns are pinned to the record schema', () => {
  expect(HOSTED_SECRET_AUDIT_SCHEMA).toEqual([
    {
      table: hubNote,
      id: hubNote.id,
      timestamp: hubNote.createdAt,
      columns: [hubNote.text, hubNote.area, hubNote.staleReason, hubNote.anchors],
    },
    {
      table: hubTask,
      id: hubTask.id,
      timestamp: hubTask.createdAt,
      columns: [hubTask.title, hubTask.body],
    },
    {
      table: hubTaskComment,
      id: hubTaskComment.id,
      timestamp: hubTaskComment.createdAt,
      columns: [hubTaskComment.body],
    },
    {
      table: hubTaskDocument,
      id: hubTaskDocument.id,
      timestamp: hubTaskDocument.createdAt,
      columns: [hubTaskDocument.title, hubTaskDocument.body],
    },
    {
      table: contextItem,
      id: contextItem.id,
      timestamp: contextItem.createdAt,
      columns: [contextItem.body, contextItem.source, contextItem.target],
    },
    {
      table: question,
      id: question.id,
      timestamp: question.createdAt,
      columns: [
        question.question,
        question.answer,
        question.answerBasis,
        question.replacement,
        question.overturnReason,
      ],
    },
    {
      table: workflowStepText,
      id: workflowStepText.id,
      timestamp: workflowStepText.createdAt,
      columns: [workflowStepText.body],
    },
    {
      table: workflowVersion,
      id: workflowVersion.id,
      timestamp: workflowVersion.createdAt,
      columns: [workflowVersion.definition, workflowVersion.author, workflowVersion.reason],
    },
    {
      table: boardMessage,
      id: boardMessage.id,
      timestamp: boardMessage.createdAt,
      columns: [boardMessage.body],
    },
    {
      table: boardMessageTag,
      id: boardMessageTag.id,
      timestamp: null,
      columns: [boardMessageTag.value],
    },
    {
      table: doc,
      id: doc.id,
      timestamp: doc.createdAt,
      columns: [doc.title, doc.body],
    },
    {
      table: docRevision,
      id: docRevision.id,
      timestamp: docRevision.at,
      columns: [docRevision.title, docRevision.body],
    },
  ])
})

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
