// concern: unattended cleanup sweep residue reclamation
/** Enumerates monitor residue, applies the owner-gone policy, and delegates guarded reclaim. */
import { basename } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { processStartTime } from '../project/project-lock.ts'
import { type ResidueKind, reclaimResidue } from '../reclaim/reclaim-residue.ts'
import {
  refGuardInventory,
  retainedRefInventory,
  sandboxDirectoryInventory,
} from '../resources/resource-inventory.ts'
import { processTable } from '../run/run-process.ts'
import type { CleanupPresentation } from './cleanup.ts'
import {
  decideUnattendedReclaim,
  UNATTENDED_RECLAIM_KINDS,
  UNJUDGED_OWNER_WINDOW_MS,
  type UnattendedReclaimKind,
} from './cleanup-sweep-decisions.ts'

type Liveness = 'dead' | 'live' | 'unknown'
export type UnattendedResidueCandidate = {
  kind: UnattendedReclaimKind
  subject: string
  runId: number
  project: string | null
  liveness: Liveness
}

type OwnerFacts = {
  ownerSessionId: string | null
  ownerLastSeenAt: number | null
  runLastActivityAt: number
  runRecordExists: boolean
}

type Inventory = { candidates: UnattendedResidueCandidate[]; errors: string[] }
type ReclaimResult = { ok: boolean; action: string }

export type UnattendedResidueDependencies = {
  inventory?: (selectedProject: string | null) => Inventory
  ownerFacts?: (runId: number, now: number) => OwnerFacts
  reclaim?: (
    kind: ResidueKind,
    subject: string,
    options: { dryRun: boolean; allowSignal: false },
  ) => ReclaimResult
}

function conversationLiveness(runId: number): Liveness {
  const member = db()
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  if (!member) return 'unknown'
  const rows = db()
    .query('SELECT status,pid,agent_pid FROM run WHERE id=? OR parent_run_id=?')
    .all(member.root_id, member.root_id) as {
    status: string
    pid: number | null
    agent_pid: number | null
  }[]
  return rows.some(
    (row) =>
      row.status === 'running' ||
      row.status === 'asking' ||
      pidAlive(row.pid) ||
      pidAlive(row.agent_pid),
  )
    ? 'live'
    : 'dead'
}

function processLiveness(row: {
  pid: number | null
  agent: string
  agent_pid: number | null
  agent_start_time: string | null
}): Liveness {
  if (pidAlive(row.pid)) return 'live'
  if (!row.agent_pid || !pidAlive(row.agent_pid)) return 'dead'
  const inventory = processTable()
  const command = inventory.ascertainable
    ? (inventory.rows.find((item) => item.pid === row.agent_pid)?.command ?? null)
    : null
  const expectedBin = basename(AGENTS[row.agent]?.bin ?? row.agent)
  const startTimeMatches = Boolean(
    row.agent_start_time && processStartTime(row.agent_pid) === row.agent_start_time,
  )
  const commandMatches = Boolean(
    command &&
      new RegExp(`(?:^|[/\\s])${expectedBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(
        command,
      ),
  )
  return startTimeMatches && commandMatches ? 'live' : 'dead'
}

type ProjectSelection = (project: string | null) => boolean

function staleRunCandidates(selected: ProjectSelection): UnattendedResidueCandidate[] {
  const stale = db()
    .query(
      `SELECT r.id,COALESCE(r.repo,project.name) project
         FROM run r LEFT JOIN project ON project.id=r.project_id
        WHERE r.status='stale' AND r.evidence_excluded IS NULL`,
    )
    .all() as { id: number; project: string | null }[]
  return stale.flatMap((row) =>
    selected(row.project)
      ? [
          {
            kind: 'stale-run',
            subject: String(row.id),
            runId: row.id,
            project: row.project,
            liveness: conversationLiveness(row.id),
          } satisfies UnattendedResidueCandidate,
        ]
      : [],
  )
}

function processCandidates(selected: ProjectSelection): UnattendedResidueCandidate[] {
  const processes = db()
    .query(
      `SELECT r.id,r.pid,r.agent,r.agent_pid,r.agent_start_time,
              COALESCE(r.repo,project.name) project
         FROM run r LEFT JOIN project ON project.id=r.project_id
        WHERE r.status IN ('ok','failed','stale','stopped')
          AND (r.pid IS NOT NULL OR r.agent_pid IS NOT NULL OR r.agent_pgid IS NOT NULL)`,
    )
    .all() as {
    id: number
    pid: number | null
    agent: string
    agent_pid: number | null
    agent_start_time: string | null
    project: string | null
  }[]
  return processes.flatMap((row) =>
    selected(row.project)
      ? [
          {
            kind: 'process',
            subject: String(row.id),
            runId: row.id,
            project: row.project,
            liveness: processLiveness(row),
          } satisfies UnattendedResidueCandidate,
        ]
      : [],
  )
}

function retainedRefCandidates(selected: ProjectSelection): Inventory {
  const retained = retainedRefInventory()
  if (!retained.ascertainable) return { candidates: [], errors: [retained.reason] }
  return {
    errors: [],
    candidates: retained.items.flatMap((item) =>
      selected(item.project)
        ? [
            {
              kind: 'retained-ref',
              subject: `${item.project}:${item.runId}`,
              runId: item.runId,
              project: item.project,
              liveness: conversationLiveness(item.runId),
            } satisfies UnattendedResidueCandidate,
          ]
        : [],
    ),
  }
}

function refGuardCandidates(selected: ProjectSelection): Inventory {
  const guards = refGuardInventory()
  if (!guards.ascertainable) return { candidates: [], errors: [guards.reason] }
  return {
    errors: [],
    candidates: guards.items.flatMap((item) =>
      selected(item.project)
        ? [
            {
              kind: 'ref-guard',
              subject: `${item.project}:${item.runId}`,
              runId: item.runId,
              project: item.project,
              liveness: conversationLiveness(item.runId),
            } satisfies UnattendedResidueCandidate,
          ]
        : [],
    ),
  }
}

function sandboxCandidates(selected: ProjectSelection): Inventory {
  const sandboxes = sandboxDirectoryInventory(db())
  if (!sandboxes.ascertainable) return { candidates: [], errors: [sandboxes.reason] }
  return {
    errors: [],
    candidates: sandboxes.directories.flatMap((directory) => {
      const row = db()
        .query(
          `SELECT COALESCE(root.repo,project.name) project
             FROM run member
             JOIN run root ON root.id=COALESCE(member.parent_run_id,member.id)
             LEFT JOIN project ON project.id=root.project_id
            WHERE member.id=?`,
        )
        .get(directory.rootId) as { project: string | null } | null
      return selected(row?.project ?? null)
        ? [
            {
              kind: 'sandbox',
              subject: String(directory.rootId),
              runId: directory.rootId,
              project: row?.project ?? null,
              liveness: conversationLiveness(directory.rootId),
            } satisfies UnattendedResidueCandidate,
          ]
        : []
    }),
  }
}

function defaultInventory(selectedProject: string | null): Inventory {
  const selected: ProjectSelection = (project) =>
    selectedProject === null || project === selectedProject
  const inventories = [
    { candidates: staleRunCandidates(selected), errors: [] },
    { candidates: processCandidates(selected), errors: [] },
    retainedRefCandidates(selected),
    refGuardCandidates(selected),
    sandboxCandidates(selected),
  ]
  return {
    candidates: inventories.flatMap(({ candidates }) => candidates),
    errors: inventories.flatMap(({ errors }) => errors),
  }
}

function defaultOwnerFacts(runId: number, now: number): OwnerFacts {
  const row = db()
    .query(
      `SELECT root.session_id,seen.last_seen,
              (SELECT COALESCE(turn.last_event_at,turn.started_at)
                 FROM run turn
                WHERE turn.id=root.id OR turn.parent_run_id=root.id
                ORDER BY turn.turn DESC,turn.id DESC LIMIT 1) run_last_activity
         FROM run member
         JOIN run root ON root.id=COALESCE(member.parent_run_id,member.id)
         LEFT JOIN session_seen seen ON seen.session_id=root.session_id
        WHERE member.id=?`,
    )
    .get(runId) as {
    session_id: string | null
    last_seen: string | null
    run_last_activity: string
  } | null
  if (!row)
    return {
      ownerSessionId: null,
      ownerLastSeenAt: null,
      runLastActivityAt: now,
      runRecordExists: false,
    }
  return {
    ownerSessionId: row.session_id,
    ownerLastSeenAt: row.last_seen === null ? null : Date.parse(row.last_seen),
    runLastActivityAt: Date.parse(row.run_last_activity),
    runRecordExists: true,
  }
}

export function sweepUnattendedResidue(
  input: {
    dryRun: boolean
    selectedProject: string | null
    presentation: CleanupPresentation
    now?: number
  },
  dependencies: UnattendedResidueDependencies = {},
): { failed: boolean; counts: Record<UnattendedReclaimKind, number> } {
  const inventory = (dependencies.inventory ?? defaultInventory)(input.selectedProject)
  const ownerFacts = dependencies.ownerFacts ?? defaultOwnerFacts
  const reclaim = dependencies.reclaim ?? reclaimResidue
  const now = input.now ?? Date.now()
  const counts = Object.fromEntries(UNATTENDED_RECLAIM_KINDS.map((kind) => [kind, 0])) as Record<
    UnattendedReclaimKind,
    number
  >
  const failed = inventory.errors.length > 0
  for (const error of inventory.errors) input.presentation.error(error)
  for (const candidate of inventory.candidates) {
    const ruling = decideUnattendedReclaim({
      kind: candidate.kind,
      ...ownerFacts(candidate.runId, now),
      now,
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
      liveness: candidate.liveness,
      uncommittedWork: false,
    })
    if (ruling.action === 'keep') {
      input.presentation.log(`kept ${candidate.kind} ${candidate.subject}: ${ruling.reason}`)
      continue
    }
    const result = reclaim(candidate.kind, candidate.subject, {
      dryRun: input.dryRun,
      allowSignal: false,
    })
    if (!result.ok) {
      input.presentation.log(`kept ${candidate.kind} ${candidate.subject}: ${result.action}`)
      continue
    }
    counts[candidate.kind]++
    input.presentation.log(result.action)
  }
  for (const kind of UNATTENDED_RECLAIM_KINDS)
    input.presentation.log(
      `${input.dryRun ? 'would reclaim' : 'reclaimed'} ${kind} ${counts[kind]}`,
    )
  return { failed, counts }
}
