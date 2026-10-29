import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor, ruleWorkflow } from './workflow-cursor.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import { decideWorkflowRuleAnswer } from './workflow-rule-answer.ts'

test('operator-ruling steps refuse agent answers', () => {
  const refusal = decideWorkflowRuleAnswer({
    fromOperator: false,
    operatorRuling: true,
  })
  expect(refusal).toContain(`${PLATFORM_SLUG} workflow rule --from-operator`)
  expect(refusal).toContain("another floor's evidence")
  expect(
    decideWorkflowRuleAnswer({
      fromOperator: true,
      operatorRuling: true,
    }),
  ).toBeNull()
  expect(
    decideWorkflowRuleAnswer({
      fromOperator: false,
      operatorRuling: false,
    }),
  ).toBeNull()
})

test('a refused agent answer leaves an operator-ruling question open', () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const draft = setStepCatalogueLocal(
    {
      ...current,
      steps: current.steps.map((step) =>
        step.slug === 'rebase'
          ? {
              ...step,
              floor: ['recorded-artifact'],
              outcomes: ['needed', 'clear'],
              rulingOutcomes: ['needed'],
              operatorRuling: true,
            }
          : step,
      ),
    },
    'operator-ruling fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(draft.n, 'operator-ruling fixture', 'test', d)
  composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
  awaitWorkflowRuling('flow', 'fixture', 'default', args, 'Proceed?', context, d, () => {})

  expect(() =>
    ruleWorkflow('flow', 'fixture', 'default', args, 'Proceed.', false, 'cli', context, d),
  ).toThrow('--from-operator')
  expect(d.query('SELECT state,question FROM workflow_cursor').get()).toEqual({
    state: 'awaiting-ruling',
    question: 'Proceed?',
  })
  expect(d.query('SELECT answer,answered_at,closed_at,close_reason FROM question').get()).toEqual({
    answer: null,
    answered_at: null,
    closed_at: null,
    close_reason: null,
  })
  expect(d.query('SELECT count(*) count FROM question_mutation_audit').get()).toEqual({ count: 0 })
})

test('a missing pinned step reports the cursor and step slug', () => {
  const d = database()
  composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
  awaitWorkflowRuling('flow', 'fixture', 'default', args, 'Proceed?', context, d, () => {})
  const pinned = d
    .query<{ record_id: string; definition: string }, []>(
      `SELECT v.record_id,v.definition FROM workflow_cursor c
       JOIN step_catalogue_version v ON v.record_id=c.catalogue_version_record_id`,
    )
    .get()!
  const definition = JSON.parse(pinned.definition) as ReturnType<
    typeof productionStepCatalogue
  >['definition']
  definition.steps = definition.steps.filter((step) => step.slug !== 'rebase')
  d.query('UPDATE step_catalogue_version SET definition=? WHERE record_id=?').run(
    JSON.stringify(definition),
    pinned.record_id,
  )

  expect(() =>
    ruleWorkflow('flow', 'fixture', 'default', args, 'Proceed.', false, 'cli', context, d),
  ).toThrow('workflow flow for DEV-822 pinned step catalogue does not contain step "rebase"')
})
