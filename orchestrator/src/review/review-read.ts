// concern: review-read
/** Records an architect's read of one exact branch change group. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveCommitAt } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectAt } from '../project/projects.ts'
import { resolveReviewCommandCwd } from './review-command-cwd.ts'
import { branchRunOwnerSession, measureChangeGroup, serializePathSet } from './review-group.ts'
import { reviewLineage } from './review-lineage-store.ts'
import { enqueueReviewRead } from './review-outbox.ts'

type Flags = { flag(name: string): string | undefined }
type Presentation = { log(...values: unknown[]): void }
type Git = (cwd: string, args: string[]) => string
type ResolveCommit = (checkout: string, argument: string) => string

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

export function latestArchitectRead(database: Database, project: string, branch: string) {
  const lineage = reviewLineage(database, project, branch)
  const row = database
    .query<{ tip: string; note: string; recorded_at: string }, string[]>(
      `SELECT tip,note,recorded_at FROM review_read
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND branch IN (${lineage.map(() => '?').join(',')})
       ORDER BY recorded_at DESC,record_id DESC LIMIT 1`,
    )
    .get(project, ...lineage)
  return row ? { tip: row.tip, note: row.note, recordedAt: row.recorded_at } : null
}

export function requireBranchRunOwner(
  database: Database,
  project: string,
  branch: string,
  caller: string | null,
): string {
  if (!caller)
    throw new Error(
      `${PLATFORM_SLUG} review read is reserved for the branch run owner; ${callerIdentityRefusal(callerIdentity(), 'record an architect read')}`,
    )
  const owner = branchRunOwnerSession(database, project, branch)
  if (!owner) return caller
  if (caller !== owner)
    throw new Error(
      `${PLATFORM_SLUG} review read is reserved for the branch run owner; calling session does not own ${branch}`,
    )
  return caller
}

export function recordArchitectRead(
  input: { cwd: string; sha?: string; note: string },
  suppliedDatabase?: Database,
  runGit: Git = git,
  recordedAt = nowIso(),
  resolveCommit: ResolveCommit = resolveCommitAt,
): string {
  if (process.env.BOTTEGA_DEPTH !== undefined) {
    throw new Error(
      `${PLATFORM_SLUG} review read is reserved for architect sessions; BOTTEGA_DEPTH is set`,
    )
  }
  const note = input.note.trim()
  if (!note) throw new Error(`${PLATFORM_SLUG} review read requires a non-blank --note`)
  if (containsSecretShaped(note))
    throw new Error('refusing review read because its note resembles a secret')
  const database = suppliedDatabase ?? writableDb()
  const project = projectAt(input.cwd, database)
  if (!project) throw new Error(`cannot resolve a project for ${input.cwd}`)
  const branch = runGit(input.cwd, ['branch', '--show-current'])
  if (!branch)
    throw new Error(`${PLATFORM_SLUG} review read requires a checked-out branch, not detached HEAD`)
  const caller = requireBranchRunOwner(database, project.name, branch, sessionId())
  const tip = resolveCommit(input.cwd, input.sha ?? 'HEAD')
  try {
    runGit(input.cwd, ['merge-base', '--is-ancestor', tip, 'HEAD'])
  } catch {
    throw new Error(
      `${PLATFORM_SLUG} review read could not reconcile branch ${branch} with tip ${tip}; run ${PLATFORM_SLUG} review read from the worktree that has the branch containing that commit checked out (${PLATFORM_SLUG} tree open <run> opens one)`,
    )
  }
  const measured = measureChangeGroup(input.cwd, project, branch, tip)
  if (!measured) throw new Error(`could not measure the change group for ${branch} at ${tip}`)
  return writeTransaction(() => {
    const row = database
      .query<
        { record_id: string },
        [
          string,
          string,
          string,
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
          (record_id,project,project_record_id,branch,tip,patch_id,path_set,tier,note,session_id,recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
      )
      .get(
        newRecordId(),
        project.name,
        project.recordId,
        branch,
        tip,
        measured.group.patchId,
        serializePathSet(measured.group.pathSet),
        measured.tier.tier,
        note,
        caller,
        recordedAt,
      )!
    enqueueReviewRead(database, row.record_id)
    return row.record_id
  }, database)
}

export function recordArchitectReadCommand(
  argv: string[],
  flags: Flags,
  presentation: Presentation,
): void {
  if (argv.length !== 2)
    throw new Error(`${PLATFORM_SLUG} review read [--cwd <tree>] [--sha <tip>] --note <text>`)
  const recordId = recordArchitectRead({
    cwd: resolveReviewCommandCwd(flags.flag('cwd')),
    sha: flags.flag('sha'),
    note: flags.flag('note') ?? '',
  })
  presentation.log(`recorded architect review read ${recordId}`)
}
