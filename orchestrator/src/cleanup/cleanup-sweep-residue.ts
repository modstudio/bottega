// concern: unattended cleanup sweep residue reclamation
/** Enumerates monitor residue, applies the owner-gone policy, and delegates guarded reclaim. */
import { pidAlive } from '../../../shared/process-identity.ts'
import { db } from '../database/db.ts'
import {
  staleRunConditions,
  terminalProcessResidueObservations,
} from '../monitor/monitor-conditions.ts'
import { type ResidueKind, reclaimResidue } from '../reclaim/reclaim-residue.ts'
import {
  refGuardInventory,
  retainedRefInventory,
  sandboxDirectoryInventory,
} from '../resources/resource-inventory.ts'
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
  liveness?: (candidate: UnattendedResidueCandidate) => Liveness
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

type ProjectSelection = (project: string | null) => boolean

function staleRunCandidates(selected: ProjectSelection): UnattendedResidueCandidate[] {
  return staleRunConditions().flatMap((condition) => {
    const runId = Number(condition.subject.slice('run:'.length))
    const row = db()
      .query(
        `SELECT COALESCE(project.name,r.repo) project
           FROM run r LEFT JOIN project ON project.id=r.project_id WHERE r.id=?`,
      )
      .get(runId) as { project: string | null } | null
    return row && selected(row.project)
      ? [
          {
            kind: 'stale-run',
            subject: String(runId),
            runId,
            project: row.project,
            liveness: conversationLiveness(runId),
          } satisfies UnattendedResidueCandidate,
        ]
      : []
  })
}

export function unattendedProcessCandidates(
  selectedProject: string | null,
): UnattendedResidueCandidate[] {
  return terminalProcessResidueObservations().flatMap((observation) => {
    const row = db()
      .query(
        `SELECT COALESCE(project.name,r.repo) project
           FROM run r LEFT JOIN project ON project.id=r.project_id WHERE r.id=?`,
      )
      .get(observation.runId) as { project: string | null } | null
    return (selectedProject === null || row?.project === selectedProject) && row
      ? [
          {
            kind: 'process',
            subject: String(observation.runId),
            runId: observation.runId,
            project: row.project,
            liveness: observation.liveness,
          } satisfies UnattendedResidueCandidate,
        ]
      : []
  })
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
  const terminal = new Set(
    sandboxes.conversations
      .filter((conversation) => conversation.terminal)
      .map((conversation) => conversation.rootId),
  )
  return {
    errors: [],
    candidates: sandboxes.directories.flatMap((directory) => {
      if (!terminal.has(directory.rootId)) return []
      const row = db()
        .query(
          `SELECT COALESCE(project.name,root.repo) project
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

function currentLiveness(candidate: UnattendedResidueCandidate): Liveness {
  if (candidate.kind !== 'process') return conversationLiveness(candidate.runId)
  return (
    terminalProcessResidueObservations().find(
      (observation) => observation.runId === candidate.runId,
    )?.liveness ?? 'dead'
  )
}

function defaultInventory(selectedProject: string | null): Inventory {
  const selected: ProjectSelection = (project) =>
    selectedProject === null || project === selectedProject
  const inventories = [
    { candidates: staleRunCandidates(selected), errors: [] },
    { candidates: unattendedProcessCandidates(selectedProject), errors: [] },
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
  const liveness = dependencies.liveness ?? currentLiveness
  const counts = Object.fromEntries(UNATTENDED_RECLAIM_KINDS.map((kind) => [kind, 0])) as Record<
    UnattendedReclaimKind,
    number
  >
  const failed = inventory.errors.length > 0
  for (const error of inventory.errors) input.presentation.error(error)
  for (const candidate of inventory.candidates) {
    // Candidate enumeration can take minutes. Re-observe immediately before
    // dispatch so an owner or process that revived after inventory is kept.
    const now = input.now ?? Date.now()
    const ruling = decideUnattendedReclaim({
      kind: candidate.kind,
      ...ownerFacts(candidate.runId, now),
      now,
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
      liveness: liveness(candidate),
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
