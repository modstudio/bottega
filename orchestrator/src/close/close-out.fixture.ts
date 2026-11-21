import { spyOn } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'

export function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

function retainedRefFailure(args: string[]): ReturnType<typeof Bun.spawnSync> | null {
  if (args[0] === 'update-ref' && args[1] === '-d') return spawnResult('', 1)
  if (args[0] === 'rev-list' && args.includes('--count')) return spawnResult('1')
  return null
}

export function normalizedGitArgs(command: string[]): string[] {
  const rawArgs = command[0] === 'git' ? command.slice(1) : command
  const cwdStripped = rawArgs[0] === '-C' ? rawArgs.slice(2) : rawArgs
  return cwdStripped[0] === '--no-optional-locks' ? cwdStripped.slice(1) : cwdStripped
}

type LandingObservation = 'clean' | 'becomes-dirty' | 'missing-branch'
type CwdObservation = { stdout?: string | ((tree: string) => string); exitCode?: number }

function landingObservationResult(
  args: string[],
  observation: LandingObservation | undefined,
  branch: string,
  head: string,
  state: { statusCalls: number },
  sourceRefs?: string,
): ReturnType<typeof Bun.spawnSync> | null {
  if (args[0] === 'for-each-ref') {
    const branchRows = args.some((arg) => arg.includes('committerdate'))
      ? `${branch}\t${head}\t2026-11-20T00:00:00Z\n`
      : `${branch}\t${head}\n`
    return spawnResult(sourceRefs ?? (observation === 'missing-branch' ? '' : branchRows))
  }
  if (args[0] === 'status') {
    state.statusCalls++
    const dirty = observation === 'becomes-dirty' && state.statusCalls > 1
    return spawnResult(dirty ? ' M changed.ts\n' : '')
  }
  if (
    observation === 'missing-branch' &&
    args[0] === 'rev-parse' &&
    args.includes(`refs/heads/${branch}^{commit}`)
  )
    return spawnResult('', 1)
  return null
}

function observedFixtureResult(input: {
  command: string[]
  args: string[]
  tree: string
  branch: string
  head: string
  landingObservation?: LandingObservation
  landingState: { statusCalls: number }
  cwdObservation?: CwdObservation
  readerSourceRefs?: string
  landedNaming?: 'unlanded' | 'unknown'
}): ReturnType<typeof Bun.spawnSync> | null {
  if (input.command[0] === 'lsof') {
    const stdout =
      typeof input.cwdObservation?.stdout === 'function'
        ? input.cwdObservation.stdout(input.tree)
        : (input.cwdObservation?.stdout ?? '')
    return spawnResult(stdout, input.cwdObservation?.exitCode ?? 0)
  }
  if (input.landedNaming === 'unknown' && input.args[0] === 'for-each-ref')
    return spawnResult('', 1)
  return landingObservationResult(
    input.args,
    input.landingObservation,
    input.branch,
    input.head,
    input.landingState,
    input.readerSourceRefs,
  )
}

function branchFixtureResult(input: {
  args: string[]
  branch: string
  head: string
  landedNaming?: 'unlanded' | 'unknown'
}): ReturnType<typeof Bun.spawnSync> | null {
  const { args } = input
  if (args[0] === 'symbolic-ref') return spawnResult(input.branch)
  if (args[0] === 'diff') return spawnResult()
  if (input.landedNaming === 'unlanded' && args[0] === 'cherry')
    return spawnResult(`+ ${input.head}`)
  if (args[0] === 'rev-list' && args.includes('--count'))
    return spawnResult(input.landedNaming === 'unlanded' ? '1' : '0')
  if (args[0] === 'merge-base' || args[0] === 'rev-parse' || args[0] === 'show-ref')
    return spawnResult(input.head)
  return null
}

function fallbackFixtureResult(input: {
  args: string[]
  tree: string
  branch: string
  head: string
  retainedRefDeleteFails: boolean
  landedNaming?: 'unlanded' | 'unknown'
}): ReturnType<typeof Bun.spawnSync> {
  const { args } = input
  if (args[0] === 'worktree' && args[1] === 'remove') {
    rmSync(input.tree, { recursive: true, force: true })
    return spawnResult()
  }
  const failure = input.retainedRefDeleteFails ? retainedRefFailure(args) : null
  if (failure) return failure
  if (args.includes('--git-common-dir')) return spawnResult('.git')
  if (args.includes('--is-inside-work-tree')) return spawnResult('true')
  if (args[0] === 'worktree' && args[1] === 'list')
    return spawnResult(`worktree ${input.tree}\nbranch refs/heads/${input.branch}\n`)
  const branchResult = branchFixtureResult(input)
  if (branchResult) return branchResult
  return spawnResult()
}

export function closeOutFixture(
  ownership: 'owned' | 'attached',
  retainedRefDeleteFails = false,
  landingObservation?: LandingObservation,
  cwdObservation?: CwdObservation,
  observeBeforeLock?: (tree: string) => void,
  readerSourceRefs?: string,
  landedNaming?: 'unlanded' | 'unknown',
) {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `close-out-${id}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
  const branch = `DEV-647-orch-${id}`
  const head = '1234567890abcdef1234567890abcdef12345678'
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(tree, { recursive: true })
  const ownerRecordId =
    ownership === 'owned'
      ? db()
          .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
          .get(id)!.record_id
      : newRecordId()
  writeFileSync(join(tree, '.orch-run'), `${ownerRecordId}\n${repo}\nsource: git\n`)
  const projectRecordId = newRecordId()
  upsertProject({
    recordId: projectRecordId,
    name: project,
    path: repo,
    settings: { trunk: 'main' },
  })
  db()
    .query(
      `UPDATE run SET repo=?, project_record_id=?, cwd=?, worktree=?, branch=?, minted_branch=?,
       base_commit=?, worktree_source='git', head_commit=?, launch_key='DEV-647' WHERE record_id=?`,
    )
    .run(project, projectRecordId, tree, tree, branch, branch, head, head, id)
  if (landingObservation)
    db()
      .query(
        "UPDATE run SET job='landing-tree', minted_branch=NULL, session_id='owner' WHERE record_id=?",
      )
      .run(id)
  const landingState = { statusCalls: 0 }
  const spawnCommands: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    spawnCommands.push(command)
    if (command.join(' ') === 'ps -axo pid=,ppid=,pgid=,command=') observeBeforeLock?.(tree)
    const args = normalizedGitArgs(command)
    return (
      observedFixtureResult({
        command,
        args,
        tree,
        branch,
        head,
        landingObservation,
        landingState,
        cwdObservation,
        readerSourceRefs,
        landedNaming,
      }) ??
      fallbackFixtureResult({ args, tree, branch, head, retainedRefDeleteFails, landedNaming })
    )
  }) as typeof Bun.spawnSync)
  return { id, repo, tree, spawnCommands }
}
