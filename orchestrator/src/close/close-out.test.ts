import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  clearConversationKeepTreeHold,
  closeOutRun,
  extractionRunId,
  releaseRunFailoverAttempts,
} from './close-out.ts'
import { closeOutCommand } from './close-out-command.ts'

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

function normalizedGitArgs(command: string[]): string[] {
  const rawArgs = command[0] === 'git' ? command.slice(1) : command
  const cwdStripped = rawArgs[0] === '-C' ? rawArgs.slice(2) : rawArgs
  return cwdStripped[0] === '--no-optional-locks' ? cwdStripped.slice(1) : cwdStripped
}

function landingObservationResult(
  command: string[],
  observation: 'clean' | 'becomes-dirty' | 'missing-branch' | undefined,
  branch: string,
  state: { statusCalls: number },
): { args: string[]; result: ReturnType<typeof Bun.spawnSync> | null } {
  const args = normalizedGitArgs(command)
  if (args[0] === 'status') {
    state.statusCalls++
    const dirty = observation === 'becomes-dirty' && state.statusCalls > 1
    return { args, result: spawnResult(dirty ? ' M changed.ts\n' : '') }
  }
  if (
    observation === 'missing-branch' &&
    args[0] === 'rev-parse' &&
    args.includes(`refs/heads/${branch}^{commit}`)
  ) {
    return { args, result: spawnResult('', 1) }
  }
  return { args, result: null }
}

function closeOutFixture(
  ownership: 'owned' | 'attached',
  retainedRefDeleteFails = false,
  landingObservation?: 'clean' | 'becomes-dirty' | 'missing-branch',
) {
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
  if (landingObservation) {
    db()
      .query("UPDATE run SET job='landing-tree', minted_branch=NULL, session_id='owner' WHERE id=?")
      .run(id)
  }
  const landingState = { statusCalls: 0 }
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const observed = landingObservationResult(command, landingObservation, branch, landingState)
    const { args } = observed
    if (observed.result) return observed.result
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
    if (args[0] === 'diff') return spawnResult()
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

test("a resumed turn's retained branch claim is settled with the branch it marks kept", () => {
  const fixture = closeOutFixture('owned')
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: fixture.id,
    turn: 2,
  })
  const turnBranch = `DEV-1128-orch-${child}`
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(`close-out-${fixture.id}`) as {
      id: number
    }
  ).id
  db()
    .query(
      `UPDATE run SET repo=?,project_id=?,cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?
       WHERE id=?`,
    )
    .run(
      `close-out-${fixture.id}`,
      projectId,
      fixture.tree,
      fixture.tree,
      turnBranch,
      turnBranch,
      '1234567890abcdef1234567890abcdef12345678',
      child,
    )
  const claimId = Number(
    db()
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
         VALUES (?,?,?,'branch',?,'claimed','2026-10-06T00:00:00.000Z')`,
      )
      .run(fixture.id, child, projectId, `refs/heads/${turnBranch}`).lastInsertRowid,
  )

  try {
    expect(closeOutRun(child, { intent: 'terminal' }).outcome).toBe('released')
    expect(
      db().query('SELECT state,settled_detail FROM resource_claim WHERE id=?').get(claimId),
    ).toEqual({
      state: 'retained',
      settled_detail: 'branch retained at 1234567890abcdef1234567890abcdef12345678',
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

test('present-tree recipe teardown becomes done with successful close-out', () => {
  const fixture = closeOutFixture('owned')
  upsertProject({
    name: `close-out-${fixture.id}`,
    path: fixture.repo,
    settings: { trunk: 'main', worktree: { recipePath: '.orch/worktree.jsonc' } },
  })
  const snapshot = JSON.stringify({
    source: { path: '.orch/worktree.jsonc', commit: 'abc' },
    recipe: {
      create: [],
      destroy: [{ name: 'release resources', run: { command: 'teardown-marker', args: [] } }],
    },
  })
  db()
    .query(
      `UPDATE run SET worktree_source='recipe',recipe_snapshot=?,resource_teardown='pending'
       WHERE id=?`,
    )
    .run(snapshot, fixture.id)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('released')
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('present-tree recipe teardown stays done when Git removal fails and is not repeated', () => {
  const fixture = closeOutFixture('owned')
  upsertProject({
    name: `close-out-${fixture.id}`,
    path: fixture.repo,
    settings: { trunk: 'main', worktree: { recipePath: '.orch/worktree.jsonc' } },
  })
  const snapshot = JSON.stringify({
    source: { path: '.orch/worktree.jsonc', commit: 'abc' },
    recipe: {
      create: [],
      destroy: [{ name: 'release resources', run: { command: 'teardown-marker', args: [] } }],
    },
  })
  db()
    .query(
      `UPDATE run SET worktree_source='recipe',recipe_snapshot=?,resource_teardown='pending'
       WHERE id=?`,
    )
    .run(snapshot, fixture.id)
  const commands: string[] = []
  const head = '1234567890abcdef1234567890abcdef12345678'
  const branch = `DEV-647-orch-${fixture.id}`
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = normalizedGitArgs(command)
    commands.push(args.join(' '))
    if (args.join(' ') === 'teardown-marker') return spawnResult()
    if (args[0] === 'worktree' && args[1] === 'remove') return spawnResult('', 1)
    if (args.includes('--git-common-dir')) return spawnResult('.git')
    if (args.includes('--is-inside-work-tree')) return spawnResult('true')
    if (args[0] === 'worktree' && args[1] === 'list') {
      return spawnResult(`worktree ${fixture.tree}\nbranch refs/heads/${branch}\n`)
    }
    if (args[0] === 'symbolic-ref') return spawnResult(branch)
    if (args[0] === 'diff') return spawnResult()
    if (args[0] === 'rev-list' && args.includes('--count')) return spawnResult('0')
    if (args[0] === 'merge-base' || args[0] === 'rev-parse' || args[0] === 'show-ref') {
      return spawnResult(head)
    }
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('failed')
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('failed')
    expect(commands.filter((command) => command === 'teardown-marker')).toHaveLength(1)
    expect(existsSync(fixture.tree)).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('present-tree inline-recipe teardown stays done when Git removal fails and is not repeated', () => {
  const fixture = closeOutFixture('owned')
  upsertProject({
    name: `close-out-${fixture.id}`,
    path: fixture.repo,
    settings: { trunk: 'main', worktree: { recipe: { stop: 'inline-stop-marker' } } },
  })
  db()
    .query("UPDATE run SET worktree_source='recipe',resource_teardown='pending' WHERE id=?")
    .run(fixture.id)
  const commands: string[] = []
  const head = '1234567890abcdef1234567890abcdef12345678'
  const branch = `DEV-647-orch-${fixture.id}`
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = normalizedGitArgs(command)
    commands.push(args.join(' '))
    if (args.join(' ') === 'sh -c inline-stop-marker') return spawnResult()
    if (args[0] === 'worktree' && args[1] === 'remove') return spawnResult('', 1)
    if (args.includes('--git-common-dir')) return spawnResult('.git')
    if (args.includes('--is-inside-work-tree')) return spawnResult('true')
    if (args[0] === 'worktree' && args[1] === 'list') {
      return spawnResult(`worktree ${fixture.tree}\nbranch refs/heads/${branch}\n`)
    }
    if (args[0] === 'symbolic-ref') return spawnResult(branch)
    if (args[0] === 'diff') return spawnResult()
    if (args[0] === 'rev-list' && args.includes('--count')) return spawnResult('0')
    if (args[0] === 'merge-base' || args[0] === 'rev-parse' || args[0] === 'show-ref') {
      return spawnResult(head)
    }
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('failed')
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('failed')
    expect(commands.filter((command) => command === 'sh -c inline-stop-marker')).toHaveLength(1)
    expect(existsSync(fixture.tree)).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('landing-tree sweep rechecks cleanliness under the close-out lock', () => {
  const fixture = closeOutFixture('owned', false, 'becomes-dirty')
  try {
    const result = closeOutRun(fixture.id, { intent: 'sweep' })

    expect(result).toMatchObject({
      outcome: 'held',
      detail: 'landing tree held by session owner: tree is dirty',
    })
    expect(existsSync(fixture.tree)).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('clean landing-tree close-out persists held while reporting kept', () => {
  const fixture = closeOutFixture('owned', false, 'clean')
  const lines: string[] = []
  const exitCodes: number[] = []
  try {
    closeOutCommand(fixture.id, true, {
      log: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`kept run ${fixture.id} ${fixture.tree}: clean landing tree;`)
    expect(exitCodes).toEqual([])
    expect(db().query('SELECT close_out_outcome FROM run WHERE id=?').get(fixture.id)).toEqual({
      close_out_outcome: 'held',
    })
    expect(existsSync(fixture.tree)).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('landing-tree sweep does not substitute tree HEAD for a missing branch ref', () => {
  const fixture = closeOutFixture('owned', false, 'missing-branch')
  try {
    const result = closeOutRun(fixture.id, { intent: 'sweep' })

    expect(result).toMatchObject({ outcome: 'held' })
    expect(result.detail).toContain('landing status could not be established')
    expect(result.detail).toContain('refs/heads/DEV-647-orch-')
    expect(existsSync(fixture.tree)).toBe(true)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('absent terminal landing-tree close-out clears its pointer and settles missing residue', () => {
  const id = addRun({ agent: '(architect)', job: 'landing-tree', status: 'ok' })
  const project = `absent-landing-close-out-${id}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${id}-land`)
  mkdirSync(join(repo, '.git'), { recursive: true })
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(project) as { id: number }
  ).id
  db()
    .query(
      `UPDATE run SET repo=?,project_id=?,cwd=?,worktree=?,branch=?,minted_branch=NULL,
       session_id='owner' WHERE id=?`,
    )
    .run(project, projectId, tree, tree, `DEV-1023-orch-${id}`, id)
  db()
    .query(
      `INSERT INTO resource_claim
       (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
       VALUES (?,?,?,'worktree',?,'claimed','2026-09-29T00:00:00.000Z')`,
    )
    .run(id, id, projectId, tree)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = normalizedGitArgs(command)
    if (args.includes('--git-common-dir')) return spawnResult('.git')
    if (args[0] === 'rev-parse') return spawnResult('', 1)
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    db()
      .query(
        `INSERT INTO landing (project,branch,status,started_at)
         VALUES (?,?,'queued','2026-09-29T00:00:00.000Z')`,
      )
      .run(project, `DEV-1023-orch-${id}`)
    expect(closeOutRun(id, { intent: 'explicit' })).toMatchObject({
      outcome: 'held',
      detail: 'landing tree held by session owner: landing is in flight',
    })
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: tree })
    db().query("UPDATE landing SET status='landed',finished_at='2026-09-29T00:01:00.000Z'").run()

    const child = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      parent: id,
    })
    db().query('UPDATE run SET pid=NULL,agent_pid=? WHERE id=?').run(process.pid, child)
    expect(closeOutRun(id, { intent: 'sweep' })).toMatchObject({
      outcome: 'live',
      detail: `live run(s): ${child} (running)`,
    })
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: tree })
    db().query('UPDATE run SET pid=?,agent_pid=NULL WHERE id=?').run(process.pid, child)
    expect(closeOutRun(id, { intent: 'sweep' })).toMatchObject({
      outcome: 'live',
      detail: `live run(s): ${child} (running)`,
    })
    db().query("UPDATE run SET status='ok',pid=NULL WHERE id=?").run(child)

    const result = closeOutRun(id, { intent: 'sweep' })

    expect(result).toMatchObject({ outcome: 'absent' })
    expect(result.detail).toContain(`ref-guard ${project}:${id} was already absent`)
    expect(result.detail).toContain(`retained ref ${project}:${id} was already absent`)
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: null })
    expect(
      db()
        .query("SELECT state FROM resource_claim WHERE root_run_id=? AND kind='worktree'")
        .get(id),
    ).toEqual({ state: 'absent' })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('absent landing-tree close-out rechecks conversation liveness before clearing pointers', () => {
  const id = addRun({ agent: '(architect)', job: 'landing-tree', status: 'ok' })
  const child = addRun({ agent: 'codex', job: 'implement', status: 'running', parent: id })
  const project = `absent-landing-liveness-${id}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${id}-land`)
  const branch = `DEV-1023-orch-${id}`
  mkdirSync(join(repo, '.git'), { recursive: true })
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  db()
    .query(
      `UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,minted_branch=?,session_id='owner'
       WHERE id=?`,
    )
    .run(project, tree, tree, branch, branch, id)
  let becameAlive = false
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = normalizedGitArgs(command)
    if (!becameAlive && args[0] === 'rev-parse') {
      becameAlive = true
      db().query('UPDATE run SET agent_pid=? WHERE id=?').run(process.pid, child)
    }
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(id, { intent: 'explicit' })).toMatchObject({
      outcome: 'live',
      detail: `live run(s): ${child} (running)`,
    })
    expect(becameAlive).toBe(true)
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: tree })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('clearing a keep-tree hold lets terminal close-out proceed', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose', status: 'ok' })
  db()
    .query(
      'UPDATE run SET worktree=?, keep_tree=1, keep_tree_until=?, keep_tree_reason=? WHERE id=?',
    )
    .run(
      '/no-such-keep-tree-hold',
      '2099-01-01T00:00:00.000Z',
      'filed-issue coordinator verifies this tree',
      id,
    )

  expect(closeOutRun(id, { intent: 'terminal' }).outcome).toBe('held')
  clearConversationKeepTreeHold(id)
  expect(closeOutRun(id, { intent: 'terminal' }).outcome).toBe('absent')
})

function absentRecipeFixture() {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `absent-recipe-${id}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
  mkdirSync(join(repo, '.git'), { recursive: true })
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  const snapshot = JSON.stringify({
    source: { path: '.orch/worktree.jsonc', commit: 'abc' },
    recipe: {
      create: [],
      destroy: [{ name: 'release resources', run: { command: 'teardown-marker', args: [] } }],
    },
  })
  db()
    .query(
      `UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,
       worktree_source='recipe',recipe_snapshot=?,resource_teardown='pending' WHERE id=?`,
    )
    .run(project, tree, tree, `DEV-979-orch-${id}`, `DEV-979-orch-${id}`, 'abc', snapshot, id)
  return { id, repo, tree }
}

test('an absent tracked-recipe tree tears resources down without Git worktree removal', () => {
  const fixture = absentRecipeFixture()
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    expect(result.outcome).toBe('absent')
    expect(result.detail).toContain('worktree was already absent; resources torn down')
    expect(commands).toContain('teardown-marker')
    expect(commands.some((command) => command.includes('worktree remove'))).toBe(false)
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('absent')
    expect(commands.filter((command) => command === 'teardown-marker')).toHaveLength(1)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('absent-tree recipe teardown stays done when retained-ref unpin fails', () => {
  const fixture = absentRecipeFixture()
  const commands: string[] = []
  const head = '1234567890abcdef1234567890abcdef12345678'
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = normalizedGitArgs(command)
    commands.push(args.join(' '))
    if (args.join(' ') === 'teardown-marker') return spawnResult()
    if (args.includes('--git-common-dir')) return spawnResult('.git')
    if (args.includes('--is-inside-work-tree')) return spawnResult('true')
    if (args[0] === 'update-ref' && args[1] === '-d') return spawnResult('', 1)
    if (args[0] === 'rev-list' && args.includes('--count')) return spawnResult('1')
    if (args[0] === 'rev-parse' || args[0] === 'show-ref' || args[0] === 'update-ref') {
      return spawnResult(head)
    }
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'explicit' }).outcome).toBe('failed')
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
    expect(closeOutRun(fixture.id, { intent: 'explicit' }).outcome).toBe('absent')
    expect(commands.filter((command) => command === 'teardown-marker')).toHaveLength(1)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('a failed absent-tree teardown stays pending and retries', () => {
  const fixture = absentRecipeFixture()
  let attempts = 0
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    if (args.join(' ') === 'teardown-marker') {
      attempts++
      return spawnResult('', attempts === 1 ? 1 : 0)
    }
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    const first = closeOutRun(fixture.id, { intent: 'terminal' })
    expect(first).toMatchObject({ outcome: 'failed' })
    expect(first.detail).toContain('recipe teardown failed at "release resources"')
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('pending')

    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('absent')
    expect(attempts).toBe(2)
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('a legacy absent tracked-recipe tree with null teardown state is not torn down', () => {
  const fixture = absentRecipeFixture()
  db().query('UPDATE run SET resource_teardown=NULL WHERE id=?').run(fixture.id)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    if (args.includes('--show-toplevel')) return spawnResult(fixture.repo)
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('absent')
    expect(commands).not.toContain('teardown-marker')
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('an absent attached tree does not run its registered remove command', () => {
  const fixture = absentRecipeFixture()
  db()
    .query('UPDATE run SET recipe_snapshot=NULL,worktree_source=? WHERE id=?')
    .run('git', fixture.id)
  upsertProject({
    name: `absent-recipe-${fixture.id}`,
    path: fixture.repo,
    settings: { trunk: 'main', worktree: { remove: 'registered-remove-marker {path}' } },
  })
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('absent')
    expect(commands.some((command) => command.includes('registered-remove-marker'))).toBe(false)
    expect(commands.some((command) => command.includes('worktree remove'))).toBe(false)
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('an absent recipe tree runs its registered remove command without Git removal', () => {
  const fixture = absentRecipeFixture()
  db().query('UPDATE run SET recipe_snapshot=NULL WHERE id=?').run(fixture.id)
  upsertProject({
    name: `absent-recipe-${fixture.id}`,
    path: fixture.repo,
    settings: { trunk: 'main', worktree: { remove: 'registered-remove-marker {path}' } },
  })
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    if (args.includes('--show-toplevel')) return spawnResult(fixture.repo)
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('absent')
    expect(commands.some((command) => command.includes('registered-remove-marker'))).toBe(true)
    expect(commands.some((command) => command.includes('worktree remove'))).toBe(false)
    expect(
      (
        db().query('SELECT resource_teardown FROM run WHERE id=?').get(fixture.id) as {
          resource_teardown: string | null
        }
      ).resource_teardown,
    ).toBe('done')
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('absent')
    expect(commands.filter((command) => command.includes('registered-remove-marker'))).toHaveLength(
      1,
    )
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('a live sharer blocks absent-tree recipe teardown', () => {
  const fixture = absentRecipeFixture()
  const sharer = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  db().query('UPDATE run SET worktree=?,pid=? WHERE id=?').run(fixture.tree, process.pid, sharer)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    expect(closeOutRun(fixture.id, { intent: 'terminal' }).outcome).toBe('live')
    expect(commands).not.toContain('teardown-marker')
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('absent-tree dry run reports teardown without executing it', () => {
  const fixture = absentRecipeFixture()
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return spawnResult()
  }) as typeof Bun.spawnSync)
  try {
    const result = closeOutRun(fixture.id, { intent: 'explicit', dryRun: true })
    expect(result).toMatchObject({ outcome: 'absent' })
    expect(result.detail).toContain('would run its recorded resource teardown')
    expect(commands).not.toContain('teardown-marker')
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('releasing a failover successor releases every held attempt oldest first', () => {
  const predecessor = addRun({
    agent: 'codex',
    job: 'diagnose',
    status: 'failed',
  })
  const successor = addRun({ agent: 'claude', job: 'diagnose', status: 'ok' })
  const holdUntil = '2099-01-01T00:00:00.000Z'
  db()
    .query(
      `UPDATE run SET worktree=?, keep_tree=1, keep_tree_until=?, keep_tree_reason=?
       WHERE id=?`,
    )
    .run('/no-such-failover-predecessor', holdUntil, 'filed-issue coordinator', predecessor)
  db()
    .query(
      `UPDATE run SET retry_of=?, worktree=?, keep_tree=1, keep_tree_until=?, keep_tree_reason=?
       WHERE id=?`,
    )
    .run(
      predecessor,
      '/no-such-failover-successor',
      holdUntil,
      'filed-issue coordinator',
      successor,
    )

  expect(closeOutRun(predecessor, { intent: 'terminal' }).outcome).toBe('held')
  expect(closeOutRun(successor, { intent: 'terminal' }).outcome).toBe('held')
  expect(releaseRunFailoverAttempts(successor).map((result) => result.runId)).toEqual([
    predecessor,
    successor,
  ])
  expect(closeOutRun(predecessor, { intent: 'terminal' }).outcome).toBe('absent')
  expect(closeOutRun(successor, { intent: 'terminal' }).outcome).toBe('absent')
})
