import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writingAcpDenyWrite } from '../sandbox/sandbox.ts'
import { acpWriteAdmission, writeAcpFile } from './acp-fs-write.ts'
import { decideAcpPermission } from './transport.ts'
import { ACP_FIXTURE_EDIT_PERMISSION } from './transport-acp.fixtures.ts'
import { resolveAcpEditLocations } from './transport-acp.ts'

describe('ACP file writes are admitted by one root', () => {
  test('a writing run may write in its worktree or its scratch directory', () => {
    const tree = '/tree'
    const scratch = '/scratch'
    expect(
      acpWriteAdmission({ writing: true, worktree: tree, scratch, path: '/tree/src/a.ts' }),
    ).toEqual({ admitted: true, root: tree })
    expect(
      acpWriteAdmission({ writing: true, worktree: tree, scratch, path: '/scratch/reply.json' }),
    ).toEqual({ admitted: true, root: scratch })
  })

  test('a writing run is refused outside both roots', () => {
    expect(
      acpWriteAdmission({
        writing: true,
        worktree: '/tree',
        scratch: '/scratch',
        path: '/etc/passwd',
      }),
    ).toEqual({ admitted: false, reason: 'outside' })
  })

  test('a read-only run writes only in scratch', () => {
    expect(
      acpWriteAdmission({
        writing: false,
        worktree: '/tree',
        scratch: '/scratch',
        path: '/tree/a.ts',
      }),
    ).toEqual({ admitted: false, reason: 'outside' })
    expect(
      acpWriteAdmission({
        writing: false,
        worktree: '/tree',
        scratch: '/scratch',
        path: '/scratch/reply.json',
      }),
    ).toEqual({ admitted: true, root: '/scratch' })
  })

  test('a writing run is refused a path the writer profile denies', () => {
    const worktree = '/tree'
    expect(
      acpWriteAdmission({ writing: true, worktree, scratch: '/scratch', path: '/tree/.git' }),
    ).toEqual({ admitted: false, reason: 'sandbox-denied' })
    expect(
      acpWriteAdmission({ writing: true, worktree, scratch: '/scratch', path: '/tree/src/a.ts' }),
    ).toEqual({ admitted: true, root: worktree })
  })

  test('a run with no configured root is refused as unconfigured', () => {
    expect(
      acpWriteAdmission({
        writing: false,
        worktree: '/tree',
        scratch: undefined,
        path: '/scratch/reply.json',
      }),
    ).toEqual({ admitted: false, reason: 'no-root' })
  })
})

describe('the ACP write handler confines to the admitted root', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const tempRoot = (prefix: string) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    roots.push(root)
    return root
  }

  test("a writing run's write lands in the worktree file and in scratch", () => {
    const worktree = tempRoot('orch-acp-write-tree-')
    const scratch = tempRoot('orch-acp-write-scratch-')
    const target = join(worktree, 'src', 'notes.txt')
    mkdirSync(join(worktree, 'src'))
    writeAcpFile({ writingAcp: true, worktree, scratch, path: target, content: 'written' })
    expect(readFileSync(target, 'utf8')).toBe('written')
    const reply = join(scratch, 'reply.json')
    writeAcpFile({ writingAcp: true, worktree, scratch, path: reply, content: '{}' })
    expect(readFileSync(reply, 'utf8')).toBe('{}')
  })

  test('a symlink escaping the worktree is refused', () => {
    const worktree = tempRoot('orch-acp-write-link-tree-')
    const scratch = tempRoot('orch-acp-write-link-scratch-')
    const outside = tempRoot('orch-acp-write-link-outside-')
    symlinkSync(outside, join(worktree, 'link'))
    expect(() =>
      writeAcpFile({
        writingAcp: true,
        worktree,
        scratch,
        path: join(worktree, 'link', 'escaped.txt'),
        content: 'no',
      }),
    ).toThrow('outside the allowed root')
  })

  test('a read-only run may not write into the worktree', () => {
    const worktree = tempRoot('orch-acp-write-ro-tree-')
    const scratch = tempRoot('orch-acp-write-ro-scratch-')
    expect(() =>
      writeAcpFile({
        writingAcp: false,
        worktree,
        scratch,
        path: join(worktree, 'notes.txt'),
        content: 'no',
      }),
    ).toThrow('outside the allowed root')
  })

  test('a run with no scratch directory is refused by that name', () => {
    const worktree = tempRoot('orch-acp-write-noscratch-tree-')
    expect(() =>
      writeAcpFile({
        writingAcp: false,
        worktree,
        scratch: undefined,
        path: join(worktree, 'notes.txt'),
        content: 'no',
      }),
    ).toThrow('BOTTEGA_SCRATCH is not set')
  })

  test('a writing run may not write the worktree git pointer the profile denies', () => {
    const worktree = tempRoot('orch-acp-write-git-tree-')
    const scratch = tempRoot('orch-acp-write-git-scratch-')
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n')
    expect(() =>
      writeAcpFile({
        writingAcp: true,
        worktree,
        scratch,
        path: join(worktree, '.git'),
        content: 'HIJACKED',
      }),
    ).toThrow('sandbox-denied')
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe('gitdir: /elsewhere\n')
  })

  test('a symlink onto the denied git pointer is refused', () => {
    const worktree = tempRoot('orch-acp-write-gitlink-tree-')
    const scratch = tempRoot('orch-acp-write-gitlink-scratch-')
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n')
    symlinkSync(join(worktree, '.git'), join(worktree, 'alias'))
    expect(() =>
      writeAcpFile({
        writingAcp: true,
        worktree,
        scratch,
        path: join(worktree, 'alias'),
        content: 'no',
      }),
    ).toThrow('sandbox-denied')
  })

  test('the deny list is the writer profile list, not a copied entry', () => {
    const worktree = tempRoot('orch-acp-write-deny-tree-')
    const scratch = tempRoot('orch-acp-write-deny-scratch-')
    const denyWrite = [...writingAcpDenyWrite(worktree), join(worktree, 'src', 'locked.ts')]
    expect(denyWrite).toContain(join(worktree, '.git'))
    for (const denied of denyWrite) {
      expect(() =>
        writeAcpFile({
          writingAcp: true,
          worktree,
          scratch,
          path: denied,
          content: 'no',
          denyWrite,
        }),
      ).toThrow('sandbox-denied')
    }
  })
})

describe('the permission edge admits the same roots as the write', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test("a writing run's worktree edit is permitted, then written, end to end", () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'orch-acp-perm-tree-')))
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orch-acp-perm-scratch-')))
    roots.push(worktree, scratch)
    const target = join(worktree, 'src', 'a.ts')
    mkdirSync(join(worktree, 'src'))
    const resolved = resolveAcpEditLocations({ writing: true, worktree, scratch }, [
      { path: target },
    ])
    expect(resolved?.admittedRoots).toEqual([worktree])
    expect(
      decideAcpPermission(
        'edit',
        ACP_FIXTURE_EDIT_PERMISSION.options,
        resolved?.locations,
        resolved?.admittedRoots,
      ).decision,
    ).toBe('allow')
    writeAcpFile({ writingAcp: true, worktree, scratch, path: target, content: 'written' })
    expect(readFileSync(target, 'utf8')).toBe('written')
  })

  test('the same worktree edit is refused for a read-only run', () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'orch-acp-perm-ro-tree-')))
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orch-acp-perm-ro-scratch-')))
    roots.push(worktree, scratch)
    const target = join(worktree, 'src', 'a.ts')
    const resolved = resolveAcpEditLocations({ writing: false, worktree, scratch }, [
      { path: target },
    ])
    expect(resolved).toBeNull()
    expect(
      decideAcpPermission(
        'edit',
        ACP_FIXTURE_EDIT_PERMISSION.options,
        resolved?.locations,
        resolved?.admittedRoots,
      ).decision,
    ).toBe('reject')
  })
})
