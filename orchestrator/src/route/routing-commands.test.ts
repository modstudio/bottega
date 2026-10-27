import { expect, test } from 'bun:test'
import { setMachineDelegation } from '../../../shared/machine-config.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { recordDuels } from '../score/duel.ts'
import { MIN_SAMPLE } from './route.ts'
import { guideCommand, pickCommand, statsCommand } from './routing-commands.ts'

const preview = (avoid: string[] = [], distinctModels: string[] = [], lens?: string) => {
  const lines: string[] = []
  pickCommand(
    {
      jobName: 'review-lens',
      stack: null,
      avoid,
      distinctModels,
      lens,
      selectedAgent: undefined,
    },
    { has: () => false, flag: () => undefined },
    { log: (...parts) => lines.push(parts.join(' ')), agents: AGENTS },
  )
  return lines.join('\n')
}

test('stats reports Bradley-Terry strengths once a job reaches MIN_SAMPLE duels', () => {
  for (let i = 0; i < MIN_SAMPLE; i++)
    recordDuels(
      addRun({ agent: 'codex', job: 'craft' }),
      [addRun({ agent: 'grok', job: 'craft' })],
      's',
      new Date().toISOString(),
    )
  const lines: string[] = []
  statsCommand(
    { flag: (name) => (name === 'job' ? 'craft' : undefined), has: () => false },
    { log: (...parts) => lines.push(parts.join(' ')), dur: String },
  )
  expect(lines.join('\n')).toContain(`craft Bradley-Terry strengths (${MIN_SAMPLE} duels)`)
  expect(lines.join('\n')).toContain('codex')
})

test('stats reports median call usage for an agent and job cell', () => {
  const runId = addRun({ agent: 'codex', job: 'craft', status: 'failed', kind: 'other' })
  db()
    .query(
      'UPDATE run SET model=?,vendor_tokens=900,model_calls=3,peak_call_tokens=400 WHERE record_id=?',
    )
    .run(AGENTS.codex!.model, runId)
  const lines: string[] = []
  statsCommand(
    { flag: (name) => (name === 'job' ? 'craft' : undefined), has: () => false },
    { log: (...parts) => lines.push(parts.join(' ')), dur: String },
  )
  expect(lines.join('\n')).toContain('calls  peak call  tokens/run')
  expect(lines.find((line) => line.includes('codex'))).toMatch(/\s3\s+400\s+900\s/)
})

test('stats reports chain cost per accepted result beside the existing cost', () => {
  const accepted = addRun({ agent: 'codex', job: 'craft', startedAt: '2026-10-01T00:00:00Z' })
  const turn = addRun({
    agent: 'codex',
    job: 'craft',
    parent: accepted,
    turn: 2,
    startedAt: '2026-10-01T00:01:00Z',
  })
  const rejected = addRun({
    agent: 'codex',
    job: 'craft',
    startedAt: '2026-10-01T00:02:00Z',
  })
  score(accepted, 'full', 'right')
  score(rejected, 'full', 'wrong')
  for (const [id, cost] of [
    [accepted, 0.2],
    [turn, 0.3],
    [rejected, 0.5],
  ] as const) {
    db()
      .query('UPDATE run SET vendor_cost_usd=?,vendor_cost_source=? WHERE record_id=?')
      .run(cost, 'vendor', id)
  }
  const lines: string[] = []
  statsCommand(
    { flag: (name) => (name === 'job' ? 'craft' : undefined), has: () => false },
    {
      log: (...parts) => lines.push(parts.join(' ')),
      dur: String,
      subscriptionCost: {
        facts: {
          agents: { codex: { billing: 'metered', harness: 'codex' } },
          monthTokens: {},
        },
        prices: {},
      },
    },
  )
  expect(lines[0]).toContain('cost  $/accepted')
  expect(lines.find((line) => line.includes('codex'))).toEndWith('$1.0000')
})

test('pick previews the same fan-out exclusions do uses', () => {
  const prior = addRun({ agent: 'grok', job: 'review-lens' })
  db().query('UPDATE run SET model=? WHERE record_id=?').run(AGENTS.grok!.model, prior)
  expect(preview(['grok'])).toContain('review-lens -> codex')
  expect(preview([], [AGENTS.grok!.model!])).toContain('review-lens -> codex')
})

test('pick shares do validation for fan-out exclusions', () => {
  const shown = preview(['grok'])
  expect(shown).toContain('review-lens -> codex')
  expect(shown).not.toContain('review-lens -> grok')
})

test('pick refuses an unmet constraint instead of silently routing', () => {
  expect(() => preview(['grok', 'codex'])).toThrow('routing constraints leave no eligible agent')
})

test('pick reports the source of each resolved lens profile', () => {
  expect(preview([], [], 'correctness')).toContain(
    'selected profiles: framework=default@1 source=generic',
  )
})

test('guide continues across harness and external delegation classes', () => {
  setMachineDelegation('delegation.implement', 'harness')
  try {
    const lines: string[] = []
    guideCommand(
      { flag: () => undefined, has: () => false },
      { log: (...parts) => lines.push(parts.join(' ')), dur: String },
    )
    const output = lines.join('\n')
    expect(output).toContain('implement')
    expect(output).toContain("harness's own sub-agent")
    expect(output).toContain('delegation.implement=harness')
    expect(output).toContain('review-lens')
    expect(output).toContain('routes to')
  } finally {
    setMachineDelegation('delegation.implement', 'external')
  }
})
