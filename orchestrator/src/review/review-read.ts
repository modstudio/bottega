// concern: review-read
/** Records an architect's read of one exact branch change group. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectAt } from '../project/projects.ts'
import { branchRunOwnerSession, measureChangeGroup, serializePathSet } from './review-group.ts'
import { enqueueReviewRead } from './review-outbox.ts'

type Flags = { flag(name: string): string | undefined }
type Presentation = { log(...values: unknown[]): void }
type Git = (cwd: string, args: string[]) => string

const git: Git = (cwd, args) => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

export function requireBranchRunOwner(
  database: Database,
  project: string,
  branch: string,
  caller: string | null,
): string {
  if (!caller)
    throw new Error(
      'orch review read is reserved for the branch run owner; CLAUDE_CODE_SESSION_ID is not set',
    )
  const owner = branchRunOwnerSession(database, project, branch)
  if (!owner)
    throw new Error(
      `orch review read is reserved for the branch run owner; ${branch} has no owned root run`,
    )
  if (caller !== owner)
    throw new Error(
      `orch review read is reserved for the branch run owner; calling session does not own ${branch}`,
    )
  return caller
}

export function recordArchitectRead(
  input: { cwd: string; sha?: string; note: string },
  suppliedDatabase?: Database,
  runGit: Git = git,
  recordedAt = nowIso(),
): number {
  if (process.env.ORCH_DEPTH !== undefined) {
    throw new Error('orch review read is reserved for architect sessions; ORCH_DEPTH is set')
  }
  const note = input.note.trim()
  if (!note) throw new Error('orch review read requires a non-blank --note')
  if (containsSecretShaped(note))
    throw new Error('refusing review read because its note resembles a secret')
  const database = suppliedDatabase ?? writableDb()
  const project = projectAt(input.cwd, database)
  if (!project) throw new Error(`cannot resolve a project for ${input.cwd}`)
  const branch = runGit(input.cwd, ['branch', '--show-current'])
  if (!branch) throw new Error('orch review read requires a checked-out branch, not detached HEAD')
  const caller = requireBranchRunOwner(database, project.name, branch, sessionId())
  const tip = runGit(input.cwd, ['rev-parse', '--verify', `${input.sha ?? 'HEAD'}^{commit}`])
  const measured = measureChangeGroup(input.cwd, project, branch, tip)
  if (!measured) throw new Error(`could not measure the change group for ${branch} at ${tip}`)
  return writeTransaction(() => {
    const row = database
      .query<
        { id: number },
        [
          string,
          string,
          number,
          string,
          string,
          string,
          string,
          number,
          string,
          string | null,
          string,
        ]
      >(
        `INSERT INTO review_read
          (record_id,project,project_id,branch,tip,patch_id,path_set,tier,note,session_id,recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
        project.name,
        project.id,
        branch,
        tip,
        measured.group.patchId,
        serializePathSet(measured.group.pathSet),
        measured.tier.tier,
        note,
        caller,
        recordedAt,
      )!
    enqueueReviewRead(database, row.id)
    return row.id
  }, database)
}

export function recordArchitectReadCommand(
  argv: string[],
  flags: Flags,
  presentation: Presentation,
): void {
  if (argv.length !== 2) throw new Error('orch review read [--sha <tip>] --note <text>')
  const id = recordArchitectRead({
    cwd: process.cwd(),
    sha: flags.flag('sha'),
    note: flags.flag('note') ?? '',
  })
  presentation.log(`recorded architect review read ${id}`)
}
