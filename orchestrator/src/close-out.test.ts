import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../test/fixtures/store.ts'
import { closeOutRun, extractionRunId } from './close-out.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'

afterEach(() => {
  mock.restore()
})

function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

/** A unique branch is pinned by a retained ref, and deleting that ref fails. */
function retainedRefFailure(args: string[]): ReturnType<typeof Bun.spawnSync> | null {
  if (args[0] === 'update-ref' && args[1] === '-d') return spawnResult('', 1)
  if (args[0] === 'rev-list' && args.includes('--count')) return spawnResult('1')
  return null
}

function closeOutFixture(ownership: 'owned' | 'attached', retainedRefDeleteFails = false) {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `close-out-${id}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
  const branch = `DEV-647-orch-${id}`
  const head = '1234567890abcdef1234567890abcdef12345678'
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(tree, { recursive: true })
  writeFileSync(
    join(tree, '.orch-run'),
    `${ownership === 'owned' ? id : id + 1}\n${repo}\nsource: git\n`,
  )
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  db()
    .query(
      `UPDATE run SET repo=?, cwd=?, worktree=?, branch=?, minted_branch=?,
       base_commit=?, worktree_source='git', head_commit=? WHERE id=?`,
    )
    .run(project, tree, tree, branch, branch, head, head, id)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = command[0] === 'git' ? command.slice(1) : command
    if (args[0] === 'worktree' && args[1] === 'remove') {
      rmSync(tree, { recursive: true, force: true })
      return spawnResult()
    }
    const failure = retainedRefDeleteFails ? retainedRefFailure(args) : null
    if (failure) return failure
    if (args.includes('--git-common-dir')) return spawnResult('.git')
    if (args.includes('--is-inside-work-tree')) return spawnResult('true')
    if (args[0] === 'worktree' && args[1] === 'list') {
      return spawnResult(`worktree ${tree}\nbranch refs/heads/${branch}\n`)
    }
    if (args[0] === 'symbolic-ref') return spawnResult(branch)
    if (args[0] === 'status' || args[0] === 'diff') return spawnResult()
    if (args[0] === 'rev-list' && args.includes('--count')) return spawnResult('0')
    if (args[0] === 'merge-base' || args[0] === 'rev-parse' || args[0] === 'show-ref') {
      return spawnResult(head)
    }
    return spawnResult()
  }) as typeof Bun.spawnSync)
  return { id, repo, tree }
}

describe('close-out extraction decision', () => {
  test('rejects filing a child turn extraction under the conversation root', () => {
    expect(extractionRunId({ id: 4267 })).toBe(4267)
  })
})

test('close-out forgets an attached tree without removing its directory', () => {
  const fixture = closeOutFixture('attached')
  try {
    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result.outcome).toBe('forgotten')
    expect(existsSync(fixture.tree)).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('a recreated released tree path survives a second close-out', () => {
  const fixture = closeOutFixture('owned')
  try {
    const first = closeOutRun(fixture.id, { intent: 'terminal' })
    expect(first.outcome).toBe('released')
    expect(existsSync(fixture.tree)).toBe(false)
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(fixture.id)).toEqual({
      worktree: null,
    })

    mkdirSync(fixture.tree, { recursive: true })
    writeFileSync(join(fixture.tree, 'replacement'), 'caller owned\n')
    const second = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(second.outcome).toBe('absent')
    expect(existsSync(join(fixture.tree, 'replacement'))).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('a released tree clears a child turn that spells the same path differently', () => {
  const fixture = closeOutFixture('owned')
  try {
    const child = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    db()
      .query('UPDATE run SET parent_run_id=?, worktree=? WHERE id=?')
      .run(fixture.id, `${fixture.tree}/`, child)

    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('released')
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(child)).toEqual({
      worktree: null,
    })
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('a close-out that fails after removing the tree still clears its pointer', () => {
  const fixture = closeOutFixture('owned', true)
  try {
    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result.outcome).toBe('failed')
    expect(existsSync(fixture.tree)).toBe(false)
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(fixture.id)).toEqual({
      worktree: null,
    })
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})
