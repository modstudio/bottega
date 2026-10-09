import { describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveWorkerNoteAnchor,
  fileFact,
  stableWorkerNoteFileAnchor,
  validateWorkerNoteInput,
  WORKER_NOTE_MAX_FILE_BYTES,
  WORKER_NOTE_MAX_LENGTH,
  workerNoteFileRefusal,
} from './worker-note.ts'
import { workerNoteTransition } from './worker-note-request.ts'

describe('worker note edge validation', () => {
  test('accepts one bounded line and a relative path:line anchor', () => {
    expect(validateWorkerNoteInput({ text: '  outside defect  ', file: 'src/file.ts:12' })).toEqual(
      {
        text: 'outside defect',
        file: 'src/file.ts:12',
      },
    )
    expect(validateWorkerNoteInput({ text: 'x'.repeat(WORKER_NOTE_MAX_LENGTH) }).text).toHaveLength(
      WORKER_NOTE_MAX_LENGTH,
    )
  })

  test('names empty, multiline, oversized, and unsafe anchor refusals', () => {
    expect(() => validateWorkerNoteInput({ text: '   ' })).toThrow('cannot be empty')
    expect(() => validateWorkerNoteInput({ text: 'first\nsecond' })).toThrow('single line')
    expect(() => validateWorkerNoteInput({ text: 'x'.repeat(WORKER_NOTE_MAX_LENGTH + 1) })).toThrow(
      '1,000 Unicode code units',
    )
    expect(() => validateWorkerNoteInput({ text: 'defect', file: 'src/file.ts' })).toThrow(
      'relative path:line form',
    )
    expect(() => validateWorkerNoteInput({ text: 'defect', file: '/tmp/file.ts:1' })).toThrow(
      'relative to the run tree',
    )
    expect(() => validateWorkerNoteInput({ text: 'defect', file: '../file.ts:1' })).toThrow(
      'inside the run tree',
    )
    expect(() =>
      validateWorkerNoteInput({ text: 'defect', file: `${'x'.repeat(1_001)}:1` }),
    ).toThrow('at most 1,000')
  })
})

test('worker note anchors contain only run and injected file facts', () => {
  expect(
    deriveWorkerNoteAnchor(
      {
        id: 42,
        project: 'workshop',
        projectPath: '/projects/workshop',
        tree: '/runs/42/tree',
        branch: 'DEV-1029-worker',
        sessionId: 'session-42',
        headCommit: 'abc123',
      },
      { path: 'src/file.ts', line: 7, content: 'const defect = true' },
    ),
  ).toEqual({
    cwd: '/projects/workshop',
    project: 'workshop',
    files: [{ path: '/projects/workshop/src/file.ts', line: 7, content: 'const defect = true' }],
    run_id: 42,
    branch: null,
    commit: 'abc123',
    session_id: 'session-42',
  })
})

test('worker note file anchors require the same line in the main checkout', () => {
  const tree = { path: 'src/file.ts', line: 7, content: 'const defect = true' }
  expect(stableWorkerNoteFileAnchor(tree, 'const defect = true')).toEqual({ file: tree })
  expect(stableWorkerNoteFileAnchor(tree, 'const defect = false')).toEqual({
    dropped:
      'File anchor src/file.ts:7 was dropped because the line is new or changed on the branch.',
  })
  expect(stableWorkerNoteFileAnchor(tree, null)).toEqual({
    dropped:
      'File anchor src/file.ts:7 was dropped because the line is new or changed on the branch.',
  })
})

test('worker note request lifecycle permits exactly one terminal transition', () => {
  expect(
    workerNoteTransition('requested', {
      status: 'filed',
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidateNotes: [
        { recordId: '01990000-0000-7000-8000-000000000008', label: 'workshop#8' },
      ],
    }),
  ).toMatchObject({
    status: 'filed',
    noteRecordId: '01990000-0000-7000-8000-000000000071',
    noteLabel: 'workshop#71',
    candidateIds: '["01990000-0000-7000-8000-000000000008"]',
    candidateLabels: '["workshop#8"]',
  })
  expect(
    workerNoteTransition('requested', {
      status: 'filed',
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidateNotes: [],
      anchorDropped: 'anchor dropped',
    }),
  ).toMatchObject({ status: 'filed', detail: 'anchor dropped' })
  expect(
    workerNoteTransition('requested', {
      status: 'refused',
      refusalClass: 'filing-refused',
      detail: 'host detail',
    }),
  ).toMatchObject({ status: 'refused', refusalClass: 'filing-refused' })
  expect(() =>
    workerNoteTransition('filed', {
      status: 'filed',
      noteRecordId: '01990000-0000-7000-8000-000000000072',
      noteLabel: 'workshop#72',
      candidateNotes: [],
    }),
  ).toThrow('already filed')
})

test('worker note file facts refuse unsafe inode and size facts', () => {
  expect(
    workerNoteFileRefusal({ symbolicLink: true, regularFile: false, links: 1, size: 1 }),
  ).toContain('symbolic link')
  expect(
    workerNoteFileRefusal({ symbolicLink: false, regularFile: false, links: 1, size: 1 }),
  ).toContain('regular file')
  expect(
    workerNoteFileRefusal({ symbolicLink: false, regularFile: true, links: 2, size: 1 }),
  ).toContain('hard links')
  expect(
    workerNoteFileRefusal({
      symbolicLink: false,
      regularFile: true,
      links: 1,
      size: WORKER_NOTE_MAX_FILE_BYTES + 1,
    }),
  ).toContain('1,000,000 bytes')
})

test('worker note file read is bounded to the requested line and rejects linked files', () => {
  const tree = mkdtempSync(join(tmpdir(), 'worker-note-'))
  mkdirSync(join(tree, 'src'))
  writeFileSync(join(tree, 'src/file.ts'), `first\nanchored\n${'x'.repeat(2_000)}`)
  expect(fileFact(tree, 'src/file.ts:2')).toEqual({
    path: 'src/file.ts',
    line: 2,
    content: 'anchored',
  })
  symlinkSync('file.ts', join(tree, 'src/link.ts'))
  expect(() => fileFact(tree, 'src/link.ts:1')).toThrow('symbolic link')
  linkSync(join(tree, 'src/file.ts'), join(tree, 'src/hard.ts'))
  expect(() => fileFact(tree, 'src/file.ts:1')).toThrow('hard links')
})
