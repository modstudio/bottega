import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  evaluateNoteStaleness,
  type NoteStalenessFacts,
  type StalenessAnchor,
} from './note-staleness.ts'

const projectName = PLATFORM_SLUG
const projectPath = `/repos/${projectName}`

const anchor = (overrides: Partial<StalenessAnchor> = {}): StalenessAnchor => ({
  cwd: projectPath,
  project: projectName,
  files: [],
  run_id: null,
  branch: null,
  commit: null,
  session_id: 'reporter',
  ...overrides,
})

const facts = (overrides: Partial<NoteStalenessFacts> = {}): NoteStalenessFacts => ({
  note: {
    project: projectName,
    anchors: [anchor()],
    promotedTask: null,
    staleAt: null,
    staleReason: null,
  },
  acknowledgementSessions: [],
  existingRuns: new Set(),
  projects: [
    { name: projectName, path: projectPath, trunk: 'main' },
    { name: 'adanim', path: '/repos/adanim', trunk: 'master' },
  ],
  git: () => null,
  readFile: () => '',
  ...overrides,
})

describe('note staleness', () => {
  test('judges a cross-project branch in the anchor project repository', () => {
    const calls: string[] = []
    const result = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor({ project: 'adanim', branch: 'topic' })],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
        git: (cwd, command) => {
          calls.push(`${cwd}:${command}`)
          return cwd === '/repos/adanim' && command === 'show-ref' ? 'present' : null
        },
      }),
    )
    expect(result).toEqual({ action: 'unchanged', reason: null })
    expect(calls).toEqual(['/repos/adanim:show-ref', '/repos/adanim:merge-base'])
  })

  test('does not use trunk distance to vanish a commit anchor', () => {
    const commands: string[] = []
    const result = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor({ commit: 'old-commit' })],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
        git: (_cwd, command) => {
          commands.push(command)
          return '999'
        },
      }),
    )
    expect(result).toEqual({ action: 'unchanged', reason: null })
    expect(commands).toEqual([])
  })

  test('matches shifted file text with trimmed surrounding whitespace', () => {
    const result = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [
            anchor({
              files: [{ path: 'src/subject.ts', line: 2, content: '  const answer = 42  ' }],
            }),
          ],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
        readFile: (path) =>
          path === `${projectPath}/src/subject.ts` ? 'new line\n\tconst answer = 42\n' : null,
      }),
    )
    expect(result).toEqual({ action: 'unchanged', reason: null })
  })

  test('vanishes removed line text but treats empty stored text as existence-only', () => {
    const removed = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor({ files: [{ path: 'subject.ts', line: 7, content: 'old line' }] })],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
        readFile: () => 'different line\n',
      }),
    )
    const empty = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor({ files: [{ path: 'subject.ts', line: 99, content: '' }] })],
          promotedTask: null,
          staleAt: null,
          staleReason: null,
        },
        readFile: () => 'still exists\n',
      }),
    )
    expect(removed).toEqual({
      action: 'annotate',
      reason: 'subject.ts:7 no longer has its anchored content',
    })
    expect(empty).toEqual({ action: 'unchanged', reason: null })
  })

  test('a reporter keep is not triage while another session keep is', () => {
    const gone = anchor({ branch: 'gone' })
    const note = {
      project: projectName,
      anchors: [gone],
      promotedTask: null,
      staleAt: null,
      staleReason: null,
    }
    expect(evaluateNoteStaleness(facts({ note, acknowledgementSessions: ['reporter'] }))).toEqual({
      action: 'annotate',
      reason: 'branch gone was deleted',
    })
    expect(evaluateNoteStaleness(facts({ note, acknowledgementSessions: ['reviewer'] }))).toEqual({
      action: 'mark',
      reason: 'branch gone was deleted',
    })
  })

  test('restores stale untriaged notes and clears obsolete live annotations', () => {
    const stale = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor({ branch: 'gone' })],
          promotedTask: null,
          staleAt: '2026-10-01T00:00:00.000Z',
          staleReason: 'old reason',
        },
      }),
    )
    const obsolete = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor()],
          promotedTask: null,
          staleAt: null,
          staleReason: 'old annotation',
        },
      }),
    )
    expect(stale).toEqual({ action: 'restore', reason: 'branch gone was deleted' })
    expect(obsolete).toEqual({ action: 'restore', reason: null })
  })

  test('never restores a dropped note', () => {
    const result = evaluateNoteStaleness(
      facts({
        note: {
          project: projectName,
          anchors: [anchor()],
          promotedTask: null,
          staleAt: '2026-10-01T00:00:00.000Z',
          staleReason: 'dropped: resolved',
        },
      }),
    )
    expect(result).toEqual({ action: 'unchanged', reason: 'dropped: resolved' })
  })
})
