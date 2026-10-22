import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { judgeRun, scoreRun } from '../judgment.ts'
import { DISPOSITIONS, recordReview } from '../review/review-triage.ts'
import { REVIEW_SEVERITY } from '../review/review-vocabulary.ts'
import {
  register,
  resolveComparisonRunIds,
  resolveDuplicateRunIds,
  scoreNote,
  scorePathForJob,
} from './judgment.ts'

const trackResidue = trackedTestResidue()

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
})

const flags = (values: Record<string, string>) =>
  ({
    flag: (name: string) => values[name],
  }) as Parameters<typeof scoreNote>[0]

test('score help names every review grade and finding disposition value', () => {
  const program = new Command().name(PLATFORM_SLUG)
  register(program)
  const help = program.commands
    .find((command) => command.name() === 'score')!
    .helpInformation()
    .replace(/\s+/g, ' ')
  expect(help).toContain(
    'record N=<accepted|modified|rejected|skipped>:<detail>; accepted/modified/skipped detail is critical|high|medium|low; rejected detail is a lowercase stable category ID of 1-64 characters',
  )
  expect(help).toContain('record whether review findings were reproduced: none|some|all')
  expect(help).toContain('record the review coverage verdict: empty|partial|adequate')
  expect(help).toContain('record the review limits verdict: named|absent')
  expect(help).toContain('record the review overlap verdict: unique|shared|none|alone')
})

test('score reminder names every finding disposition value', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../../hooks/score-reminder.py', import.meta.url)),
    'utf8',
  )
  expect(hook).toContain(`--finding {ordinal}=<${DISPOSITIONS.join('|')}>:<detail>`)
  expect(hook).toContain(`accepted/modified/skipped: ${REVIEW_SEVERITY.join('|')}`)
  expect(hook).toContain('rejected: lowercase stable category ID of 1-64 characters')
})

test('inline score notes accept ordinary punctuation and quoted strings', () => {
  expect(scoreNote(flags({ note: 'The households\' reports quote "caught value".' }))).toBe(
    'The households\' reports quote "caught value".',
  )
})

test('a note file is content and bypasses shell-fragment checks', () => {
  const root = trackResidue(join(dir, 'score-note-file'))
  mkdirSync(root, { recursive: true })
  const path = join(root, 'note.txt')
  writeFileSync(path, "The households' note says `caught value`.")
  expect(scoreNote(flags({ 'note-file': path }))).toBe("The households' note says `caught value`.")
})

test('a lone inline backtick is refused as an unexpanded shell fragment', () => {
  expect(() => scoreNote(flags({ note: '`' }))).toThrow('unexpanded shell fragment')
})

test('comparison flags resolve mixed run numbers and UUIDs and deduplicate by row', () => {
  const first = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const second = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const secondRecordId = (
    db().query('SELECT record_id FROM run WHERE record_id=?').get(second) as { record_id: string }
  ).record_id
  const mixed = resolveComparisonRunIds({
    has: () => false,
    values: () => [],
    flag: (name) => (name === 'better-than' ? `${first},${secondRecordId}` : undefined),
  })
  expect(mixed.flag('better-than')).toBe(`${first},${second}`)
  expect(() =>
    resolveComparisonRunIds({
      has: () => false,
      values: () => [],
      flag: (name) => (name === 'same-as' ? `${second},${secondRecordId}` : undefined),
    }).flag('same-as'),
  ).toThrow('same run more than once')
})

test('comparison flags refuse an unknown run UUID', () => {
  expect(() =>
    resolveComparisonRunIds({
      has: () => false,
      values: () => [],
      flag: (name) => (name === 'worse-than' ? '01990000-0000-7000-8000-000000000099' : undefined),
    }).flag('worse-than'),
  ).toThrow('no run matches')
})

test('duplicate flags resolve the other run while preserving both finding ordinals', () => {
  const other = addRun({ agent: 'codex', job: 'review-lens', status: 'ok' })
  const number = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(other)!.number
  const resolved = resolveDuplicateRunIds({
    has: () => false,
    flag: () => undefined,
    values: (name) => (name === 'duplicate' ? [`2=${number}#3`] : []),
  })
  expect(resolved.values('duplicate')).toEqual([`2=${other}#3`])
})

test('findings jobs take the judge path and another job takes the score path', () => {
  expect(scorePathForJob('review-lens')).toBe('judge')
  expect(scorePathForJob('implement')).toBe('score')
})

test('voiding a findings run takes the score path, and the score path refuses discard', () => {
  const given =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name)
  expect(scorePathForJob('review-lens', given('void'))).toBe('score')
  expect(scorePathForJob('review-lens', given('discard'))).toBe('judge')
  expect(() => scorePathForJob('implement', given('discard'))).toThrow('--discard applies only')
  expect(() => scorePathForJob('review-lens', given('void', 'discard'))).toThrow(
    '--discard applies only',
  )
  expect(scorePathForJob('review-lens', given('finding'))).toBe('judge')
  expect(() => scorePathForJob('review-lens', given('scorer', 'finding'))).toThrow(
    '--finding applies only',
  )
})

const scoreFlags = (input: Record<string, string | string[] | boolean> = {}) => ({
  has: (name: string) =>
    input[name] === true || typeof input[name] === 'string' || Array.isArray(input[name]),
  flag: (name: string) =>
    typeof input[name] === 'string'
      ? (input[name] as string)
      : Array.isArray(input[name])
        ? (input[name] as string[])[0]
        : undefined,
  values: (name: string) =>
    Array.isArray(input[name])
      ? (input[name] as string[])
      : typeof input[name] === 'string'
        ? [input[name] as string]
        : [],
})
const silent = {
  log: (..._values: unknown[]) => {},
  error: (..._values: unknown[]) => {},
  pairHint: (partner: { id: string }) => `pair ${partner.id}`,
}

test('a review-lens run scored with only delivery names every remaining required flag once', async () => {
  const id = addRun({
    agent: 'codex',
    job: 'review-lens',
    status: 'ok',
    session: 'orch-test-session',
  })
  db().query("UPDATE run SET lens='correctness',model='m' WHERE record_id=?").run(id)
  recordReview(id, reviewReply(2, 'high'), db())
  await expect(
    judgeRun(
      id,
      scoreFlags(),
      { words: ['full'], note: null, auditReason: null, notEvidence: NOT_EVIDENCE },
      silent,
    ),
  ).rejects.toThrow(
    new RegExp(
      `${PLATFORM_SLUG} score ${id} is missing:[\\s\\S]*` +
        'quality <wrong\\|mixed\\|right>[\\s\\S]*' +
        '--reproduced none \\| some \\| all[\\s\\S]*' +
        '--coverage empty \\| partial \\| adequate[\\s\\S]*' +
        '--limits named \\| absent[\\s\\S]*' +
        '--overlap unique \\| shared \\| none \\| alone[\\s\\S]*' +
        `--finding 1=[\\s\\S]*--finding 2=[\\s\\S]*` +
        `${PLATFORM_SLUG} score ${id} full right --reproduced all --coverage adequate --limits named --overlap unique --finding 1=accepted:high --finding 2=accepted:high`,
    ),
  )
  expect(db().query('SELECT id FROM score WHERE run_record_id=?').get(id)).toBeNull()
})

test('an implement run scored with only full names quality and fidelity together', async () => {
  const id = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    session: 'orch-test-session',
  })
  await expect(
    scoreRun(
      id,
      scoreFlags(),
      {
        words: ['full'],
        note: null,
        auditReason: null,
        notEvidence: NOT_EVIDENCE,
        dashboardAuthorized: false,
      },
      silent,
    ),
  ).rejects.toThrow(
    new RegExp(
      `${PLATFORM_SLUG} score ${id} is missing:[\\s\\S]*` +
        'quality <wrong\\|mixed\\|right>[\\s\\S]*' +
        'fidelity <drifted\\|partial\\|faithful>[\\s\\S]*' +
        `${PLATFORM_SLUG} score ${id} full right faithful`,
    ),
  )
  expect(db().query('SELECT id FROM score WHERE run_record_id=?').get(id)).toBeNull()
})
