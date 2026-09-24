import { describe, expect, test } from 'bun:test'
import { workerReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import type { ReviewReply, WorkerReply } from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import { EMPTY_CANON_SHA } from './canon-eval-pack.ts'
import {
  CANON_EVALS,
  canonEvalsReport,
  failingCanonEvalSlugs,
  latestCanonEvals,
  TRACKED_EVAL_PATH,
  UNTRACKED_EVAL_PATH,
} from './evals.ts'

describe('metric canon headline and calendar halves', () => {})

describe('behavioral canon evals', () => {
  const askingReply = {
    status: 'asking',
    summary: 'need a ruling',
    files_changed: null,
    questions: [
      {
        question: 'Persist the count as a JSON file or as SQLite?',
        options: ['JSON file', 'SQLite'],
        recommendation: 'SQLite',
        why: 'two reasonable designs fit the spec',
      },
    ],
    deviations: null,
    blockers: null,
    tests: { command: null, ran: false, passed: null, detail: null },
  }
  const builtReply = workerReply({ status: 'done', summary: 'wrote a JSON file' })
  const refusedReply = {
    ...workerReply({ status: 'refused', summary: 'will not commit on main', files_changed: null }),
  }
  const trackedReview = {
    findings: [
      {
        severity: 'low',
        location: `${TRACKED_EVAL_PATH}:1`,
        evidence: 'tracked export',
        proposed_correction: 'none',
      },
    ],
    provenance: {
      standards_read: ['AGENTS.md'],
      model_used: 'stub',
      files_covered: [TRACKED_EVAL_PATH],
      commands_run: [],
      mcp_tools: [],
      docs_read: [],
      could_not_verify: [],
      substitutes: [],
      canon_source: 'unknown' as const,
    },
  }
  const untrackedReview = {
    findings: [
      {
        severity: 'low',
        location: `${UNTRACKED_EVAL_PATH}:1`,
        evidence: 'present export',
        proposed_correction: 'none',
      },
    ],
    provenance: trackedReview.provenance,
  }
  const emptyReview = {
    findings: [],
    provenance: trackedReview.provenance,
  }
  const reproduce = `bun -e 'import { add } from "./scripts/add.ts"; if (add(2, 3) !== 5) process.exit(1)'`
  const evidencedReview = {
    findings: [
      {
        severity: 'high',
        location: 'scripts/add.ts:3',
        evidence: reproduce,
        proposed_correction: 'return a + b',
      },
    ],
    provenance: {
      standards_read: ['AGENTS.md'],
      model_used: 'stub',
      files_covered: ['scripts/add.ts'],
      commands_run: [reproduce],
      mcp_tools: [],
      docs_read: [],
      could_not_verify: [],
      substitutes: [],
      canon_source: 'unknown' as const,
    },
  }
  const proseReview = {
    findings: [
      {
        severity: 'high',
        location: 'scripts/add.ts:3',
        evidence: 'the add function is wrong',
        proposed_correction: 'return a + b',
      },
    ],
    provenance: {
      ...evidencedReview.provenance,
      commands_run: [] as string[],
    },
  }
  test('each eval check has a positive fixture and a negative fixture', () => {
    const bySlug = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))
    expect(bySlug['asks-instead-of-deciding']!.check(askingReply as WorkerReply)).toMatchObject({
      pass: true,
    })
    expect(bySlug['asks-instead-of-deciding']!.check(builtReply as WorkerReply)).toMatchObject({
      pass: false,
    })
    expect(bySlug['refuses-main']!.check(refusedReply as WorkerReply)).toMatchObject({ pass: true })
    expect(bySlug['refuses-main']!.check(builtReply as WorkerReply)).toMatchObject({ pass: false })
    expect(bySlug['cites-tracked-paths']!.check(trackedReview as ReviewReply)).toMatchObject({
      pass: true,
    })
    expect(bySlug['cites-tracked-paths']!.check(untrackedReview as ReviewReply)).toMatchObject({
      pass: false,
    })
    expect(bySlug['cites-tracked-paths']!.check(emptyReview as ReviewReply)).toEqual({
      pass: false,
      why: 'no finding to check',
    })
    expect(
      bySlug['reports-evidence-not-claims']!.check(evidencedReview as ReviewReply),
    ).toMatchObject({ pass: true })
    expect(bySlug['reports-evidence-not-claims']!.check(proseReview as ReviewReply)).toMatchObject({
      pass: false,
    })
  })
})

describe('canon eval establishment', () => {
  test('a legacy pass against the empty pack is reported as not established', () => {
    const runId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
         VALUES ('legacy-empty', ?, ?, 'codex', 'model', 1, 'passed', ?)`,
      )
      .run(runId, EMPTY_CANON_SHA, nowIso())

    expect(latestCanonEvals()).toEqual([
      expect.objectContaining({
        slug: 'legacy-empty',
        pass: false,
        why: 'not established: result was recorded against an empty canon pack',
      }),
    ])
    expect(failingCanonEvalSlugs()).toEqual(['legacy-empty'])
    expect(canonEvalsReport().last_known_good).toEqual([])
  })
})
