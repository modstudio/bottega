import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import { confineExplicitNoteAnchor, parseNoteAnchor } from './note.ts'
import { deriveNoteFileAnchors, NOTE_ANCHOR_MAX_FILE_BYTES } from './note-file-anchors.ts'

const scratch = mkdtempSync(join(tmpdir(), 'hub-note-file-anchors-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

test('a malformed explicit anchor names its field', () => {
  const anchor: NoteAnchorWire = {
    cwd: '/fixtures/repos/workshop',
    project: 'workshop',
    files: [],
    run_record_id: null,
    branch: null,
    commit: null,
    session_id: null,
  }
  expect(() => parseNoteAnchor({ ...anchor, cwd: 7 })).toThrow('cwd')
})

test('explicit note anchors are confined to the cwd project and its registered checkout', () => {
  const anchor: NoteAnchorWire = {
    cwd: '/projects/workshop',
    project: 'workshop',
    files: [{ path: '/projects/workshop/src/file.ts', line: 2, content: 'worker content' }],
    run_record_id: '42000000-0000-4000-8000-000000000000',
    branch: null,
    commit: 'abc',
    session_id: 'session-42',
  }
  const realpath = (path: string) => path
  expect(
    confineExplicitNoteAnchor(anchor, {
      cwdProject: 'workshop',
      projectPath: '/projects/workshop',
      realpath,
    }),
  ).toBe(anchor)
  expect(() =>
    confineExplicitNoteAnchor(
      { ...anchor, project: 'other' },
      { cwdProject: 'workshop', projectPath: '/projects/workshop', realpath },
    ),
  ).toThrow('anchor.project')
  expect(() =>
    confineExplicitNoteAnchor(
      { ...anchor, files: [{ ...anchor.files[0]!, path: '/projects/other/file.ts' }] },
      { cwdProject: 'workshop', projectPath: '/projects/workshop', realpath },
    ),
  ).toThrow('anchor.files[0].path')
})

test('derived file anchors stay inside the checkout and use bounded reads', () => {
  const checkout = join(scratch, 'checkout')
  mkdirSync(checkout, { recursive: true })
  const inside = join(checkout, 'anchor.ts')
  const outside = join(scratch, 'outside.ts')
  const oversized = join(checkout, 'oversized.ts')
  writeFileSync(inside, 'first\nanchored line\n')
  writeFileSync(outside, 'outside\n')
  writeFileSync(oversized, 'x'.repeat(NOTE_ANCHOR_MAX_FILE_BYTES + 1))
  expect(
    deriveNoteFileAnchors(`inside anchor.ts:2 outside ${outside}:1 large oversized.ts:1`, checkout),
  ).toEqual([{ path: realpathSync(inside), line: 2, content: 'anchored line' }])
})
