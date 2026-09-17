import { describe, expect, test } from 'bun:test'
import { workerReply } from '../../test/fixtures/replies.ts'
import { detectBlockers } from '../failure/failure.ts'
import { JOBS } from '../jobs.ts'
import { GENERIC_QUESTION_TOKENS } from '../outcome.ts'
import {
  hasRealQuestions,
  ISSUE_WORKER_SCHEMA,
  missingDeclaredDeliverables,
  parseReaderReply,
  parseWorkerReply,
  parseWorkerReplyWithCount,
  READER_SCHEMA,
  REVIEW_SCHEMA,
  readerDeliverablesInstruction,
  realQuestions,
  resolveReplyDialect,
  TEXT_REPLY_SCHEMA,
  VERIFY_CLAIM_SCHEMA,
  WORKER_SCHEMA,
} from './contract.ts'

const baseWorkerReply = {
  status: 'done',
  summary: 'done',
  files_changed: null,
  questions: null,
  deviations: null,
  tests: null,
  blockers: null,
}

const issueWorkerReply = {
  ...baseWorkerReply,
  outcome: 'fixed',
  cause_location: 'orch-code',
  cause_matched_report: true,
  established_cause: 'cause',
  reproduction: { command: 'bun test', base_commit: 'abc123', environment: 'test', seed: null },
  before: 'red',
  after: 'green',
  plain_gate: 'pass',
  worker_gate: 'pass',
  blast_radius: 'one path',
  branch: 'DEV-462-test',
  not_established: '',
}

const reviewReply = {
  findings: [],
  provenance: {
    standards_read: [],
    model_used: 'test',
    files_covered: ['contract.ts'],
    commands_run: [],
    mcp_tools: [],
    docs_read: [],
    could_not_verify: [],
    substitutes: [],
    canon_source: 'live database',
  },
}

const readerReply = {
  deliverables: [{ name: 'answer', status: 'delivered', content: 'done' }],
  narrative: null,
  files_written: null,
}

const verifyClaimReply = {
  verdict: 'true',
  provenance: { canon_source: 'live database' },
}

describe('reply dialect resolution', () => {
  test('resolves one dialect for every registered job', () => {
    const expected = {
      'file-question': 'READER_SCHEMA',
      understand: 'READER_SCHEMA',
      diagnose: 'READER_SCHEMA',
      'issue-worker': 'ISSUE_WORKER_SCHEMA',
      'review-lens': 'REVIEW_SCHEMA',
      'review-lens-inline': 'REVIEW_SCHEMA',
      safety: 'REVIEW_SCHEMA',
      craft: 'REVIEW_SCHEMA',
      'verify-claim': 'VERIFY_CLAIM_SCHEMA',
      'canon-lookup': 'text-reply',
      summarize: 'text-reply',
      implement: 'WORKER_SCHEMA',
      fix: 'WORKER_SCHEMA',
      'mcp-query': 'text-reply',
    } as const

    expect(
      Object.fromEntries(
        Object.values(JOBS).map((job) => [job.name, resolveReplyDialect(job).schemaName]),
      ),
    ).toEqual(expected)
  })

  test('each dialect uses its schema to accept its syntax and reject incompatible syntax', () => {
    const dialects = [
      { job: JOBS.implement!, schema: WORKER_SCHEMA, valid: baseWorkerReply },
      { job: JOBS['issue-worker']!, schema: ISSUE_WORKER_SCHEMA, valid: issueWorkerReply },
      { job: JOBS['review-lens']!, schema: REVIEW_SCHEMA, valid: reviewReply },
      { job: JOBS['verify-claim']!, schema: VERIFY_CLAIM_SCHEMA, valid: verifyClaimReply },
      { job: JOBS.understand!, schema: READER_SCHEMA, valid: readerReply },
      { job: JOBS.summarize!, schema: TEXT_REPLY_SCHEMA, valid: { answer: 'done' } },
    ] as const

    for (const { job, schema, valid } of dialects) {
      const dialect = resolveReplyDialect(job)
      const incompatible =
        schema === TEXT_REPLY_SCHEMA
          ? baseWorkerReply
          : schema === ISSUE_WORKER_SCHEMA
            ? baseWorkerReply
            : { answer: 'wrong dialect' }
      expect(dialect.schema).toBe(schema)
      expect(dialect.parse(JSON.stringify(valid)).reply).not.toBeNull()
      expect(dialect.parse(JSON.stringify(incompatible)).reply).toBeNull()
    }
  })
})

test('the reader receives and echoes its ordered declared deliverables', () => {
  const names = ['per-file timing table', 'failing test name']
  expect(readerDeliverablesInstruction(names)).toContain(JSON.stringify(names))
  const reply = parseReaderReply({
    deliverables: names.map((name) => ({ name, status: 'delivered', content: 'echoed' })),
    narrative: null,
    files_written: null,
  })
  expect(reply?.deliverables.map(({ name }) => name)).toEqual(names)
  expect(missingDeclaredDeliverables(names, reply)).toEqual([])
})
test('a diagnose reply missing a deliverable is unevidenced', () => {
  expect(
    missingDeclaredDeliverables(['x'], { deliverables: [], narrative: null, files_written: null }),
  ).toEqual(['x'])
})
test('a blocked deliverable with a reason is accepted', () => {
  expect(
    missingDeclaredDeliverables(['x'], {
      deliverables: [{ name: 'x', status: 'blocked', content: 'docker.sock denied' }],
      narrative: null,
      files_written: null,
    }),
  ).toEqual([])
})
test('files_written naming scratch/reply.json survives the scratch-to-artifacts rename', () => {
  expect(
    parseReaderReply({
      deliverables: [{ name: 'answer', status: 'delivered', content: 'done' }],
      narrative: null,
      files_written: ['/tmp/scratch/reply.json'],
    })?.files_written,
  ).toEqual(['/tmp/scratch/reply.json'])
})
test('orch do diagnose --deliverable x returns unevidenced when x is missing', () => {
  expect(
    missingDeclaredDeliverables(
      ['x'],
      parseReaderReply({ deliverables: [], narrative: 'prose', files_written: null }),
    ),
  ).toEqual(['x'])
})

test('multiple contracts leave a visible note on an otherwise successful run', () => {
  const parsed = parseWorkerReplyWithCount(
    [
      { ...baseWorkerReply, summary: 'real reply' },
      { ...baseWorkerReply, summary: 'quoted contract-shaped object' },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n'),
  )
  expect(parsed.reply?.summary).toBe('quoted contract-shaped object')
  expect(parsed.contractObjects).toBe(2)
})

describe('a worker that stops to ask is not a worker that failed', () => {
  test('an unparseable reply is rejected rather than read as a status', () => {
    // The dangerous direction: treating "no structured reply" as success would
    // record an unverifiable change set as a completed implementation.
    expect(parseWorkerReply('I have finished the work, it all looks good.')).toBeNull()
    expect(parseWorkerReply('')).toBeNull()
  })
  test('an unknown status is not silently promoted to done', () => {
    expect(parseWorkerReply(JSON.stringify(workerReply({ status: 'partially-done' })))).toBeNull()
  })
  test('the object is recovered from prose and from a fence', () => {
    const fenced = parseWorkerReply(
      `Here is my report:\n\`\`\`json\n${JSON.stringify(workerReply())}\n\`\`\``,
    )
    expect(fenced?.status).toBe('done')
    const embedded = parseWorkerReply(
      `Result: ${JSON.stringify(
        workerReply({
          status: 'asking',
          summary: 'need a ruling',
          questions: null,
        }),
      )} — over to you`,
    )
    expect(embedded?.status).toBe('asking')
  })
  test('a schema-shaped reply keeps its optional recommendation', () => {
    const r = parseWorkerReply(
      JSON.stringify(
        workerReply({
          status: 'asking',
          summary: 'stopped',
          questions: [
            {
              question: 'one table or two?',
              options: ['one', 'two'],
              recommendation: 'two',
              why: null,
            },
          ],
        }),
      ),
    )
    expect(r?.questions?.[0]?.recommendation).toBe('two')
  })
  test('a status alone is not a worker contract', () => {
    expect(parseWorkerReply('{"status":"done"}')).toBeNull()
  })
  test('wrong-typed nested values reject the whole candidate', () => {
    expect(
      parseWorkerReply(
        JSON.stringify(
          workerReply({
            questions: [
              {
                question: 'q?',
                options: null,
                recommendation: {},
                why: null,
              },
            ],
          }),
        ),
      ),
    ).toBeNull()
  })
  test('an asking reply keeps every question with text and why', () => {
    const asking = (questions: unknown[]) =>
      parseWorkerReply(
        JSON.stringify(
          workerReply({
            status: 'asking',
            questions,
          }),
        ),
      )
    expect(
      hasRealQuestions(
        asking([
          {
            question: 'one table or two?',
            options: null,
            recommendation: null,
            why: 'the choice changes the migration',
          },
        ]),
      ),
    ).toBe(true)
    expect(
      hasRealQuestions(
        asking([
          {
            question: 'which table?',
            options: null,
            recommendation: null,
            why: '   ',
          },
        ]),
      ),
    ).toBe(false)
    for (const why of ['\u200B', '\u2060', '\u00AD', '\u200B\u2060']) {
      expect(
        hasRealQuestions(
          asking([
            {
              question: 'one table or two?',
              options: null,
              recommendation: null,
              why,
            },
          ]),
        ),
      ).toBe(false)
    }
    for (const token of GENERIC_QUESTION_TOKENS) {
      expect(
        hasRealQuestions(
          asking([
            {
              question: token,
              options: null,
              recommendation: null,
              why: 'a claimed reason',
            },
          ]),
        ),
      ).toBe(false)
    }
    for (const disguised of ['(placeholder)!', '[TBD]', 'TODO?', '...question...']) {
      expect(
        hasRealQuestions(
          asking([
            {
              question: disguised,
              options: null,
              recommendation: null,
              why: 'a claimed reason',
            },
          ]),
        ),
      ).toBe(false)
    }
    expect(
      hasRealQuestions(
        asking([
          {
            question: '\u200B\u2060',
            options: null,
            recommendation: null,
            why: 'a claimed reason',
          },
        ]),
      ),
    ).toBe(false)
    const partial = asking([
      {
        question: 'which table?',
        options: null,
        recommendation: null,
        why: 'the schema changes',
      },
      { question: '   ', options: null, recommendation: null, why: 'unknown choice' },
    ])
    expect(hasRealQuestions(partial)).toBe(true)
    expect(realQuestions(partial).map((item) => item.question)).toEqual(['which table?'])
    expect(
      hasRealQuestions(
        parseWorkerReply(
          JSON.stringify(
            workerReply({
              status: 'done',
              questions: [
                {
                  question: 'Which table?',
                  options: null,
                  recommendation: null,
                  why: 'the schema changes',
                },
              ],
            }),
          ),
        ),
      ),
    ).toBe(true)
  })
})

describe('a worker asking is not a worker blocked', () => {
  test('the old word is accepted and normalised', () => {
    const r = parseWorkerReply(
      JSON.stringify(
        workerReply({
          status: 'blocked',
          summary: 'x',
          questions: [
            {
              question: 'q?',
              options: null,
              recommendation: null,
              why: null,
            },
          ],
        }),
      ),
    )
    expect(r?.status).toBe('asking')
  })
  test('the two vocabularies do not overlap', () => {
    const asking = parseWorkerReply(JSON.stringify(workerReply({ status: 'asking', summary: 'x' })))
    expect(asking?.status).toBe('asking')
    expect(detectBlockers('Docker access was denied, so I could not run the suite.')).not.toEqual(
      [],
    )
  })
})

describe('a worker that narrates in its own reply shape', () => {
  test('the LAST object wins, not the first and not the span', () => {
    const r = parseWorkerReply(
      [
        workerReply({ summary: 'Starting by reading the canon', files_changed: [] }),
        workerReply({ summary: 'Added the section', files_changed: ['a.ts', 'b.ts'] }),
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
    )
    expect(r?.summary).toBe('Added the section')
    expect(r?.files_changed).toEqual(['a.ts', 'b.ts'])
  })
  test('a brace inside a string is not a brace', () => {
    expect(
      parseWorkerReply(JSON.stringify(workerReply({ summary: 'uses {curly} braces' })))?.summary,
    ).toBe('uses {curly} braces')
  })
  test('a later object that does not validate does not shadow a good one', () => {
    const r = parseWorkerReply(
      `${JSON.stringify(workerReply({ summary: 'real' }))}\n{"note":"trailing object with no status"}`,
    )
    expect(r?.summary).toBe('real')
  })
  test('multiple valid contract objects report their count and take the last', () => {
    const parsed = parseWorkerReplyWithCount(
      [
        workerReply({ summary: 'real reply' }),
        workerReply({ summary: 'quoted contract-shaped object' }),
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
    )
    expect(parsed.reply?.summary).toBe('quoted contract-shaped object')
    expect(parsed.contractObjects).toBe(2)
  })
})
