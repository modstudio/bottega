import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'
import { recordReviewFunnelDecision } from './review-funnel-decision-log.ts'

test('records the terminal decision and outbox row in one transaction', () => {
  const database = migratedTestDatabase()
  const project = newRecordId()
  database
    .query("INSERT INTO project(record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')")
    .run(project)
  const change = {
    project: 'fixture',
    taskKey: 'DEV-1',
    branch: 'DEV-1-branch',
    head: 'head',
    patchId: 'patch',
    pathSet: '["file.ts"]',
    paths: ['file.ts'],
  }
  const facts = { change, stack: 'typescript' } as ReviewFunnelFacts
  const verdict = {
    policyVersion: 'builtin',
    mode: 'evaluate',
    change,
    tier: { tier: 1, risk: 1, size: 1, firm: false, lowered: false, reasons: [] },
    budget: { roundsUsed: 0, ceiling: 1, atCeiling: false },
    lenses: [],
    next: { action: 'admit' },
    remedy: `${PLATFORM_SLUG} pr create`,
  } as ReviewFunnelVerdict

  const recordId = recordReviewFunnelDecision({
    database,
    surface: 'review-tier',
    outcome: 'advice',
    facts,
    verdict,
  })

  expect(
    database
      .query('SELECT facts,stack,outcome FROM review_funnel_decision WHERE record_id=?')
      .get(recordId),
  ).toEqual({
    facts: JSON.stringify(facts),
    stack: 'typescript',
    outcome: 'advice',
  })
  expect(
    database
      .query(
        "SELECT count(*) AS count FROM outbox WHERE kind='review_funnel_decision' AND row_id=?",
      )
      .get(recordId),
  ).toEqual({ count: 1 })
  database.close()
})
