import { beforeEach, expect, test } from 'bun:test'
import { setMachineValue } from '../../../shared/machine-config.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, score, seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { recordReview } from '../review/review-triage.ts'
import { recordDuels } from '../score/duel.ts'
import { MIN_SAMPLE } from './route-selection.ts'
import { guideCommand, pickCommand, statsCommand } from './routing-commands.ts'

beforeEach(() => seedNeutralCodexQuotaReading())

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
  for (const [id, cost, source] of [
    [accepted, 0.2, 'vendor'],
    [turn, null, 'none'],
    [rejected, 0.5, 'vendor'],
  ] as const) {
    db()
      .query('UPDATE run SET vendor_cost_usd=?,vendor_cost_source=? WHERE record_id=?')
      .run(cost, source, id)
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
  const row = lines.find((line) => line.includes('codex'))!
  expect(row).toContain('review off floor=80% rate=1.25x BELOW')
  expect(row).toEndWith('$1.0500 (1 imputed)')
})

test('stats distinguishes an unpriced cell from one with no accepted result', () => {
  const accepted = addRun({ agent: 'codex', job: 'craft' })
  score(accepted, 'full', 'right')
  db()
    .query('UPDATE run SET vendor_tokens=?,vendor_cost_usd=NULL WHERE record_id=?')
    .run(100, accepted)
  const lines: string[] = []
  statsCommand(
    { flag: (name) => (name === 'job' ? 'craft' : undefined), has: () => false },
    {
      log: (...parts) => lines.push(parts.join(' ')),
      dur: String,
      subscriptionCost: {
        facts: {
          agents: { codex: { billing: 'subscription', harness: 'codex' } },
          monthTokens: { codex: 100 },
        },
        prices: {},
      },
    },
  )

  expect(lines.find((line) => line.includes('codex'))).toEndWith(
    'unpriced (subscription, unpriced)',
  )
})

test('stats resolves and marks a named lens tier', () => {
  const runId = addRun({ agent: 'codex', job: 'review-lens', lens: 'correctness' })
  recordReview(runId, reviewReply(0), db())
  score(runId, 'full', 'wrong')
  const lines: string[] = []
  statsCommand(
    {
      flag: (name) =>
        name === 'job' ? 'review-lens' : name === 'lens' ? 'correctness' : undefined,
      has: () => false,
    },
    { log: (...parts) => lines.push(parts.join(' ')), dur: String },
  )
  expect(lines.find((line) => line.includes('codex'))).toContain(
    'high-stakes on floor=90% rate=3x BELOW',
  )
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

test('pick reports the source and switch of each resolved lens policy', () => {
  const output = preview([], [], 'correctness')
  expect(output).toContain('selected profiles: framework=default@1 source=generic')
  expect(output).toContain('cost policy (on): picked')
  expect(output).toContain('rate 3x/+5 (correctness, high-stakes)')

  const standard = preview([], [], 'architecture')
  expect(standard).toContain('cost policy (off): would pick')
  expect(standard).toContain('architecture, standard')
})

test('guide continues across harness and external delegation classes', () => {
  setMachineValue('delegation.implement', 'harness')
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
    setMachineValue('delegation.implement', 'external')
  }
})
