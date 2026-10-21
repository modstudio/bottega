// concern: confinement-ruling
/**
 * Knows confinement classifications, chain authority, recorded artifacts, and
 * the ruling that clears a classification. Must not know transports, routing,
 * reviews, contracts, the CLI, or durable execution.
 */
import { existsSync } from 'node:fs'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { contentTree, targetGitEnvironment } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import { machineId } from '../record/machine-identity.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from '../run/run-authority.ts'
import { rollUpRootAndEnqueue } from '../run/run-liveness.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { parseConfinement } from './confinement.ts'

type ConfinementPresentation = { log(...values: unknown[]): void }

function sameRunRecords(left: { record_id: string }[], right: { record_id: string }[]): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => row.record_id === right[index]!.record_id)
  )
}

function enqueueClearedConfinementRecords(
  database: ReturnType<typeof db>,
  rows: { record_id: string }[],
  rootId: string,
): void {
  const at = nowIso()
  const localMachineId = machineId()
  for (const row of rows) enqueueRunRecord(database, row.record_id, localMachineId, at)
  rollUpRootAndEnqueue(database, rootId, null, localMachineId, at)
}

export function clearConfinement(
  id: string,
  options: { writer: string; note: string; tip: string | null },
  presentation: ConfinementPresentation,
): void {
  const { writer, note } = options
  let authority = authorizeRunMutation(id, 'reclassify')
  const rows = db()
    .query(
      `SELECT record_id, failure_kind, error, pre_confinement, confinement FROM run
        WHERE (record_id=? OR parent_run_record_id=?)
          AND failure_kind IN ('escaped','confinement_unverified') ORDER BY turn,number`,
    )
    .all(authority.rootId, authority.rootId) as {
    record_id: string
    failure_kind: string
    error: string | null
    pre_confinement: string | null
    confinement: string | null
  }[]
  if (!rows.length) throw new Error(`run ${id}'s chain has no confinement classification to clear`)
  const chain = db()
    .query(
      `SELECT repo, worktree, branch, head_commit, input_tree FROM run
        WHERE record_id=? OR parent_run_record_id=? ORDER BY turn DESC,number DESC`,
    )
    .all(authority.rootId, authority.rootId) as {
    repo: string | null
    worktree: string | null
    branch: string | null
    head_commit: string | null
    input_tree: string | null
  }[]
  const recorded = <K extends keyof (typeof chain)[number]>(key: K) =>
    chain.find((row) => row[key] !== null)?.[key] ?? null
  const repo = recorded('repo')
  const worktree = recorded('worktree')
  const branch = recorded('branch')
  const recordedTip = recorded('head_commit')
  const recordedTree = recorded('input_tree')
  if (!repo || !worktree || !branch || !recordedTip || !recordedTree) {
    throw new Error(
      `run ${id}'s chain lacks a recorded repository, worktree, branch tip, or measured tree`,
    )
  }
  const project = projectByName(repo)
  if (!project) throw new Error(`run ${id}'s recorded project ${repo} is not registered`)
  const inspect = (cwd: string, args: string[]) => {
    const child = Bun.spawnSync(['git', ...args], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return child.exitCode === 0 ? child.stdout.toString().trim() : null
  }
  const currentTip = inspect(project.path, [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}^{commit}`,
  ])
  if (!currentTip) throw new Error(`recorded branch ${branch} no longer exists in ${project.path}`)
  const worktreeMissing = !existsSync(worktree)
  const currentTree = worktreeMissing
    ? inspect(project.path, ['rev-parse', '--verify', `${currentTip}^{tree}`])
    : contentTree(worktree)
  const suppliedTip = options.tip
  const snapshotted = rows
    .map((row) => parseConfinement(row.confinement))
    .find((value) => value?.tripTip || value?.chainRoot)
  const divergence = currentTip !== recordedTip
  const recoveryCommand = `git worktree add ${worktree} ${branch}`
  const audit = {
    writer,
    note,
    recordedTip,
    currentTip,
    recordedTree,
    currentTree,
    worktree,
    branch,
    divergence,
    suppliedTip,
    cleared: false,
    tripTip: snapshotted?.tripTip ?? null,
    chainRoot: snapshotted?.chainRoot ?? null,
  }
  const auditOnly = () =>
    writeTransaction(() => {
      authority = adoptRunMutation(authority, 'receipt')
      auditRunMutation(authority, 'reclassify', JSON.stringify(audit))
    })
  if (divergence && !suppliedTip && !snapshotted?.tripTip && !snapshotted?.chainRoot) {
    auditOnly()
    throw new Error(
      `refusing to clear confinement: ${branch} moved from recorded tip ${recordedTip} to ${currentTip}; ` +
        `pass --tip ${currentTip} to acknowledge the current artifact`,
    )
  }
  if (suppliedTip && suppliedTip !== currentTip) {
    auditOnly()
    throw new Error(`refusing --tip ${suppliedTip}: ${branch}'s current tip is ${currentTip}`)
  }
  const transitions = rows.map((row) => {
    const mode = row.pre_confinement ? 'restored' : 'forward'
    const value = (
      row.pre_confinement
        ? JSON.parse(row.pre_confinement)
        : {
            status: 'failed',
            failureKind: null,
            error: `confinement cleared forward by ${writer}: ${note}; pre-confinement outcome unavailable`,
          }
    ) as {
      status?: string
      failureKind?: string | null
      error?: string | null
      landingBlock?: { detail: string; invariant: string; command: string; worktree: string } | null
      clearMode?: 'restored' | 'forward'
    }
    if (!['ok', 'failed', 'asking', 'stopped', 'stale'].includes(value.status ?? '')) {
      throw new Error(`run ${row.record_id} has invalid pre-confinement status`)
    }
    if (worktreeMissing) {
      value.landingBlock = {
        detail: `recorded worktree ${worktree} is missing for branch ${branch}`,
        invariant: 'A cleared confinement chain needs its recorded worktree before landing.',
        command: recoveryCommand,
        worktree,
      }
    } else delete value.landingBlock
    value.clearMode = mode
    return { row, value, mode }
  })
  writeTransaction(() => {
    authority = adoptRunMutation(authority, 'receipt')
    const current = db()
      .query(
        `SELECT record_id FROM run WHERE (record_id=? OR parent_run_record_id=?)
          AND failure_kind IN ('escaped','confinement_unverified') ORDER BY turn,number`,
      )
      .all(authority.rootId, authority.rootId) as { record_id: string }[]
    if (!sameRunRecords(current, rows)) {
      throw new Error(`run ${id}'s confinement classification changed before it could be cleared`)
    }
    const update = db().query(
      `UPDATE run SET status=?, failure_kind=?, error=?, pre_confinement=?, host_wait_since=NULL WHERE record_id=?
          AND failure_kind IN ('escaped','confinement_unverified')`,
    )
    for (const { row, value } of transitions) {
      const changed = update.run(
        value.status!,
        value.failureKind ?? null,
        value.error ?? null,
        JSON.stringify(value),
        row.record_id,
      )
      if (changed.changes !== 1) {
        throw new Error(
          `run ${row.record_id}'s confinement classification changed before it could be cleared`,
        )
      }
    }
    enqueueClearedConfinementRecords(db(), rows, authority.rootId)
    auditRunMutation(
      authority,
      'reclassify',
      JSON.stringify({
        ...audit,
        cleared: true,
        transitions: transitions.map(({ row, mode }) => ({ runId: row.record_id, mode })),
        priorOutcomes: rows.map((row) => ({
          runId: row.record_id,
          failureKind: row.failure_kind,
          error: row.error,
        })),
        landingBlock: worktreeMissing ? recoveryCommand : null,
      }),
    )
  })
  presentation.log(
    `cleared confinement for chain ${authority.rootId}; ruling by ${writer}: ${note}`,
  )
  if (worktreeMissing) {
    presentation.log(
      `landing remains blocked: recorded worktree ${worktree} is missing\n` +
        `invariant: A cleared confinement chain needs its recorded worktree before landing.\n` +
        `cleared by: ${recoveryCommand}`,
    )
  }
}
