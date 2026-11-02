import { beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score, seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { promptBucketsForJob } from './prompt-size-bucket-store.ts'
import { candidates, pick } from './route.ts'
import { guideCommand, pickCommand, statsCommand } from './routing-commands.ts'

beforeEach(() => seedNeutralCodexQuotaReading())

function addPooledRun(options: {
  recordId?: string
  agent?: string
  model?: string | null
  job?: string
  stack?: string | null
  status?: 'ok' | 'failed' | 'stale'
  delivery?: string | null
  quality?: string | null
  startedAt?: string
  lens?: string
  promptBytes?: number
}): string {
  const recordId = options.recordId ?? newRecordId()
  db()
    .query(
      `INSERT INTO routing_pool_run
         (record_id,space_id,agent,model,job,stack,prompt_bytes,status,failure_kind,
          executor,evidence_excluded,started_at,latency_ms,vendor_tokens,model_calls,
          peak_call_tokens,delivery,quality,fidelity,pulled_at)
       VALUES (?,'space',?,?,?,?,?,?,NULL,'external',NULL,?,1000,100,1,100,?,?,NULL,?)`,
    )
    .run(
      recordId,
      options.agent ?? 'codex',
      options.model === undefined ? AGENTS.codex!.model : options.model,
      options.job ?? 'craft',
      options.stack ?? null,
      options.promptBytes ?? 10,
      options.status ?? 'ok',
      options.startedAt ?? new Date().toISOString(),
      options.delivery === undefined ? 'full' : options.delivery,
      options.quality === undefined ? 'right' : options.quality,
      new Date().toISOString(),
    )
  if (options.lens)
    db()
      .query('INSERT INTO routing_pool_lens (record_id,run_record_id,lens) VALUES (?,?,?)')
      .run(newRecordId(), recordId, options.lens)
  return recordId
}

test('an empty pool preserves the fixed pick result byte for byte', () => {
  const result = pick('verify-claim', undefined, 0, false)
  expect(JSON.stringify(result)).toBe(
    '{"agent":"codex","reason":"mean; preference (only 0 judged in job-wide cell on model gpt-5.6-sol, need 5); cost policy (off): would pick codex — unproven, cost no accepted results, rate 1x/+5 (light)"}',
  )
})

test('local evidence wins duplicate record ids and local-only runs still count', () => {
  const duplicate = addRun({ agent: 'codex', job: 'craft' })
  score(duplicate, 'full', 'right')
  addPooledRun({ recordId: duplicate, delivery: 'full', quality: 'wrong' })
  const localOnly = addRun({ agent: 'codex', job: 'craft' })
  score(localOnly, 'full', 'wrong')

  const candidate = candidates('craft').find((row) => row.agent === 'codex')!
  expect(candidate).toMatchObject({ evidence: 2, pooledEvidence: 0, score: 0.5, runs: 2 })
})

test('only registered agents on their current model enter the pooled window', () => {
  addPooledRun({ agent: 'remote-only', model: 'remote-model' })
  addPooledRun({ agent: 'codex', model: 'older-codex-model' })

  const rows = candidates('craft')
  expect(rows.some((row) => row.agent === 'remote-only')).toBe(false)
  expect(rows.find((row) => row.agent === 'codex')).toMatchObject({
    evidence: 0,
    pooledEvidence: 0,
  })
})

test('pooled judgments affect routing and are marked on pick, guide, and stats', () => {
  addPooledRun({ agent: 'codex', job: 'verify-claim', delivery: 'full', quality: 'wrong' })
  const candidate = candidates('verify-claim').find((row) => row.agent === 'codex')!
  expect(candidate).toMatchObject({ evidence: 1, pooledEvidence: 1, score: 0, latencyMs: 1000 })

  const pickLines: string[] = []
  pickCommand(
    {
      jobName: 'verify-claim',
      stack: null,
      avoid: [],
      distinctModels: [],
      lens: undefined,
      selectedAgent: 'codex',
    },
    { flag: () => undefined, has: () => false },
    { log: (...parts) => pickLines.push(parts.join(' ')), agents: AGENTS },
  )
  expect(pickLines.join('\n')).toContain('judged=  1 (1 pooled)')

  const guideLines: string[] = []
  guideCommand(
    {
      flag: (name) => (name === 'job' ? 'verify-claim' : undefined),
      has: () => false,
    },
    { log: (...parts) => guideLines.push(parts.join(' ')), dur: String },
  )
  expect(guideLines.join('\n')).toContain('1 judged (1 pooled)')

  const statsLines: string[] = []
  statsCommand(
    {
      flag: (name) => (name === 'job' ? 'verify-claim' : undefined),
      has: () => false,
    },
    { log: (...parts) => statsLines.push(parts.join(' ')), dur: String },
  )
  expect(statsLines.join('\n')).toContain('1 (1 pooled)')
})

test('stack and lens filters apply to pooled evidence', () => {
  addPooledRun({ stack: 'typescript', lens: 'correctness' })
  addPooledRun({ stack: 'typescript', lens: 'architecture' })
  addPooledRun({ stack: 'rust', lens: 'correctness' })

  const candidate = candidates('craft', 0, {
    stack: 'typescript',
    lens: 'correctness',
  }).find((row) => row.agent === 'codex')!
  expect(candidate).toMatchObject({ evidence: 1, pooledEvidence: 1, latencyMs: 1000 })
})

test('pooled accepted runs do not enter cost-per-accepted evidence', () => {
  const local = addRun({ agent: 'agy', job: 'craft' })
  score(local, 'full', 'right')
  db()
    .query(
      `UPDATE run
          SET vendor_cost_usd = 2, vendor_cost_source = 'reported'
        WHERE record_id = ?`,
    )
    .run(local)
  addPooledRun({
    agent: 'agy',
    model: AGENTS.agy!.model,
    job: 'craft',
    delivery: 'full',
    quality: 'right',
  })

  const candidate = candidates('craft', 0, { priceCost: true }).find((row) => row.agent === 'agy')!
  expect(candidate.costPerAccepted).toEqual({ usd: 2 })
})

test('a pooled-only large prompt establishes the large prompt bucket', () => {
  addPooledRun({ job: 'pooled-large-only', promptBytes: 20_000 })

  expect(promptBucketsForJob('pooled-large-only')).toEqual(['large'])
})
