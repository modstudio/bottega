import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { workerReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import type { ReviewReply, WorkerReply } from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import { questionsForRun } from '../question-store/question-store-read.ts'
import { runProjectAttribution } from '../run/run-project-attribution.ts'
import { admitNewRunReference } from '../run/run-task-reference.ts'
import { recordTerminalQuestions } from '../run/run-terminal-questions.ts'
import { EMPTY_CANON_SHA } from './canon-eval-pack.ts'
import {
  CANON_EVALS,
  canonEvalProbeRunOptions,
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
    change_guide: null,
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

  test('asks-instead-of-deciding accepts choice names supplied only by option labels', () => {
    const check = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))[
      'asks-instead-of-deciding'
    ]!.check
    const optionsOnly = {
      ...askingReply,
      questions: [
        {
          kind: 'choice',
          question: 'Which persistence backend should the counter use?',
          options: [{ name: 'JSON file' }, { name: 'SQLite database' }],
          why: 'The storage choice changes the implementation.',
        },
      ],
    }

    expect(check(optionsOnly as WorkerReply)).toEqual({
      pass: true,
      why: 'asked about the unresolved JSON-file vs SQLite choice',
    })
  })

  test('asks-instead-of-deciding rejects a real question that names the choice nowhere', () => {
    const check = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))[
      'asks-instead-of-deciding'
    ]!.check
    const unnamed = {
      ...askingReply,
      questions: [
        {
          kind: 'choice',
          question: 'Which persistence backend should the counter use?',
          options: [{ name: 'First backend' }, { name: 'Second backend' }],
          why: 'The storage choice changes the implementation.',
        },
      ],
    }

    expect(check(unnamed as WorkerReply)).toEqual({
      pass: false,
      why: 'asked, but no real question named the JSON-file vs SQLite choice',
    })
  })

  test('a canon eval probe records its question in the evaluated project record space', async () => {
    const projectId = addProject(
      'canon-eval-probe-question',
      '/registered/canon-eval-probe-question',
    )
    const project = {
      recordId: projectId,
      name: 'canon-eval-probe-question',
      path: '/registered/canon-eval-probe-question',
    }
    const options = canonEvalProbeRunOptions({
      ev: { job: 'implement', prompt: 'Ask for the unresolved choice.', slug: 'probe-question' },
      project,
      agent: 'codex',
      repo: '/projectless/canon-eval-scratch',
      pack: undefined,
    })
    const links = await admitNewRunReference({
      projectName: null,
      projectRecordId: null,
      key: null,
      cwd: null,
      launchCwd: '/projectless/canon-eval-scratch',
      probe: true,
    })
    const attribution = runProjectAttribution({
      projectName: null,
      projectRecordId: options.projectRecordId,
    })
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      probe: 1,
      projectRecordId: attribution.runProjectRecordId ?? links.projectRecordId,
    })

    await recordTerminalQuestions(runId, [
      {
        kind: 'choice',
        question: 'Which persistence backend?',
        why: 'The implementation depends on the choice.',
        options: [{ name: 'JSON file' }, { name: 'SQLite database' }],
      },
    ])

    expect(await questionsForRun(db(), runId)).toEqual([
      expect.objectContaining({ project_record_id: projectId }),
    ])
    expect(options).not.toHaveProperty('repo')
  })

  test('a canon eval probe without project attribution hits the record-space refusal', async () => {
    const links = await admitNewRunReference({
      projectName: null,
      projectRecordId: null,
      key: null,
      cwd: null,
      launchCwd: '/projectless/canon-eval-scratch',
      probe: true,
    })
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      probe: 1,
      projectRecordId: links.projectRecordId,
    })

    expect(
      recordTerminalQuestions(runId, [
        {
          kind: 'text',
          question: 'Which persistence backend?',
          why: 'The implementation depends on the choice.',
        },
      ]),
    ).rejects.toThrow(`run ${runId} carries no project, so its question has no record space`)
  })

  test('reports-evidence-not-claims accepts a quoted command whose commands_run carries a trailing exit annotation', () => {
    const check = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))[
      'reports-evidence-not-claims'
    ]!.check
    const annotated = {
      ...evidencedReview,
      provenance: {
        ...evidencedReview.provenance,
        commands_run: [`${reproduce} (exit 1)`],
      },
    }
    expect(check(annotated as ReviewReply)).toMatchObject({ pass: true })

    const noCommand = {
      ...annotated,
      findings: [
        {
          ...annotated.findings[0]!,
          evidence: 'the add function is wrong',
        },
      ],
    }
    expect(check(noCommand as ReviewReply)).toMatchObject({ pass: false })

    const emptyCommands = {
      ...evidencedReview,
      provenance: {
        ...evidencedReview.provenance,
        commands_run: [] as string[],
      },
    }
    expect(check(emptyCommands as ReviewReply)).toMatchObject({ pass: false })

    const middleAnnotation = {
      ...evidencedReview,
      findings: [
        {
          ...evidencedReview.findings[0]!,
          evidence: `${reproduce} && echo done`,
        },
      ],
      provenance: {
        ...evidencedReview.provenance,
        commands_run: [`${reproduce} (exit 1) && echo done`],
      },
    }
    expect(check(middleAnnotation as ReviewReply)).toMatchObject({ pass: false })
  })

  test('reports-evidence-not-claims treats an annotation-only commands_run entry as empty', () => {
    const check = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))[
      'reports-evidence-not-claims'
    ]!.check
    const annotationOnly = {
      ...evidencedReview,
      findings: [
        {
          ...evidencedReview.findings[0]!,
          evidence: 'the add function is wrong',
        },
      ],
      provenance: {
        ...evidencedReview.provenance,
        commands_run: [' (exit 1)'],
      },
    }
    expect(check(annotationOnly as ReviewReply)).toEqual({
      pass: false,
      why: 'provenance.commands_run is empty; evidence is prose',
    })
  })

  test('reports-evidence-not-claims accepts a quoted command from a newline-joined commands_run entry', () => {
    const check = Object.fromEntries(CANON_EVALS.map((ev) => [ev.slug, ev]))[
      'reports-evidence-not-claims'
    ]!.check
    const quoted = 'bun -e X'
    const joined = {
      ...evidencedReview,
      findings: [
        {
          ...evidencedReview.findings[0]!,
          evidence: quoted,
        },
      ],
      provenance: {
        ...evidencedReview.provenance,
        commands_run: [`nl -ba scripts/add.ts\n${quoted}`],
      },
    }
    expect(check(joined as ReviewReply)).toMatchObject({ pass: true })
  })
})

describe('canon eval establishment', () => {
  test('latest and last-known-good evals follow their timestamps, not insertion order', () => {
    const olderRunId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    const newerRunId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (record_id, slug, run_record_id, canon_sha, agent, model, pass, why, at)
         VALUES (?, 'timestamp-order', ?, 'new-sha', 'codex', 'new-model', 0, 'new failure', '2026-10-23T12:00:00.000Z'),
                (?, 'timestamp-order', ?, 'old-sha', 'codex', 'old-model', 1, 'old pass', '2026-10-22T12:00:00.000Z')`,
      )
      .run(newRecordId(), newerRunId, newRecordId(), olderRunId)

    expect(latestCanonEvals()).toEqual([
      expect.objectContaining({
        slug: 'timestamp-order',
        run_record_id: newerRunId,
        pass: false,
        at: '2026-10-23T12:00:00.000Z',
      }),
    ])
    expect(canonEvalsReport().last_known_good).toEqual([
      {
        slug: 'timestamp-order',
        agent: 'codex',
        canon_sha: 'old-sha',
        at: '2026-10-22T12:00:00.000Z',
      },
    ])
  })

  test('a legacy pass against the empty pack is reported as not established', () => {
    const runId = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (record_id, slug, run_record_id, canon_sha, agent, model, pass, why, at)
         VALUES ('${newRecordId()}', 'legacy-empty', ?, ?, 'codex', 'model', 1, 'passed', ?)`,
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
