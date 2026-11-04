import { expect, test } from 'bun:test'
import { addRun, seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
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

test('guide and state report an all-agents-at-capacity job as a capacity wait', () => {
  const rows = db().query('SELECT name,jobs,max_concurrent FROM agent ORDER BY name').all() as {
    name: string
    jobs: string | null
    max_concurrent: number
  }[]
  const running: string[] = []
  try {
    const update = db().query('UPDATE agent SET jobs=?, max_concurrent=? WHERE name=?')
    for (const row of rows) {
      const jobs = new Set(JSON.parse(row.jobs ?? '[]') as string[])
      if (row.name === 'codex') jobs.add('craft')
      else jobs.delete('craft')
      update.run(JSON.stringify([...jobs]), row.name === 'codex' ? 1 : row.max_concurrent, row.name)
    }
    refreshAgents()
    seedNeutralCodexQuotaReading()
    running.push(addRun({ agent: 'codex', job: 'craft', status: 'running' }))
    db().query('UPDATE run SET pid=? WHERE record_id=?').run(process.pid, running[0]!)

    for (const row of [guide('craft')[0], state(null).guide.find(({ job }) => job === 'craft')]) {
      expect(row).toMatchObject({ routesTo: null, unroutable: false })
      expect(row?.reason).toStartWith(
        'waiting for capacity: agent codex is at capacity (1 running:',
      )
      expect(row?.reason).not.toContain('\n')
    }
  } finally {
    for (const id of running) db().query("UPDATE run SET status='failed' WHERE record_id=?").run(id)
    const restore = db().query('UPDATE agent SET jobs=?, max_concurrent=? WHERE name=?')
    for (const row of rows) restore.run(row.jobs, row.max_concurrent, row.name)
    refreshAgents()
  }
})
