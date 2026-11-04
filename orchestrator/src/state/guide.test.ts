import { expect, test } from 'bun:test'
import { refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { guide, guideRouteDecision } from './guide.ts'
import { state } from './serve.ts'

test('guide and state keep one unroutable job without dropping other jobs', () => {
  const rows = db().query('SELECT name,jobs FROM agent ORDER BY name').all() as {
    name: string
    jobs: string | null
  }[]
  try {
    db()
      .query('UPDATE agent SET jobs=?')
      .run(JSON.stringify(Object.keys(JOBS).filter((name) => name !== 'diagnose')))
    refreshAgents()

    const guideRows = guide()
    const snapshotRows = state(null).guide
    const expected = {
      routesTo: null,
      unroutable: true,
      reason: 'no eligible agent for job "diagnose"',
    }
    expect(guideRows.find(({ job }) => job === 'diagnose')).toMatchObject(expected)
    expect(snapshotRows.find(({ job }) => job === 'diagnose')).toMatchObject(expected)
    expect(guideRows.find(({ job }) => job === 'implement')).toMatchObject({ unroutable: false })
  } finally {
    const restore = db().query('UPDATE agent SET jobs=? WHERE name=?')
    for (const row of rows) restore.run(row.jobs, row.name)
    refreshAgents()
  }
})

test('the unroutable guide decision is pure over a refusal headline', () => {
  expect(
    guideRouteDecision('external', 'delegation.review', {
      kind: 'refused',
      headline: 'no eligible agent for job "diagnose"',
    }),
  ).toEqual({
    delegation: 'external',
    routesTo: null,
    unroutable: true,
    reason: 'no eligible agent for job "diagnose"',
  })
})
