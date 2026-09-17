// concern: isolation
/** Owns explicit reclamation command behavior. Must not know CLI grammar. */
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'
import { type ResidueKind, reclaimResidue } from './reclaim-residue.ts'

const RESIDUE_KINDS = new Set<ResidueKind>([
  'ref-guard',
  'sandbox',
  'retained-ref',
  'trust',
  'process',
  'stale-run',
])

function reclaimFixtureQuestionsCommand(
  subject: string | undefined,
  dryRun: boolean,
  presentation: { log(value: string): void },
): void {
  if (subject) throw new Error('orch reclaim fixture-questions takes no subject')
  const hub = new URL('../../bin/hub', import.meta.url).pathname
  const result = Bun.spawnSync(
    [hub, 'reclaim-fixture-questions', ...(dryRun ? ['--dry-run'] : []), '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || 'hub fixture-question reclaim failed')
  const payload = JSON.parse(result.stdout.toString()) as {
    rows: { question_id: number; session_id: string; run_ref: string }[]
  }
  for (const row of payload.rows)
    presentation.log(
      `${dryRun ? 'would remove' : 'removed'} fixture question ${row.question_id} ${row.session_id} ${row.run_ref}`,
    )
  if (!payload.rows.length) presentation.log('no orphan fixture questions found')
}

function reclaimNamed(kind: string, subject: string, dryRun: boolean) {
  if (kind === 'worktree') return reclaimWorktree(subject, { dryRun })
  if (kind === 'branch') return reclaimBranch(subject, { dryRun })
  return reclaimResidue(kind as ResidueKind, subject, { dryRun })
}

export function reclaimCommand(
  kind: string,
  subject: string | undefined,
  dryRun: boolean,
  presentation: { log(value: string): void },
): void {
  if (kind === 'fixture-questions') {
    reclaimFixtureQuestionsCommand(subject, dryRun, presentation)
    return
  }
  if (!subject) throw new Error(`orch reclaim ${kind} requires a subject`)
  if (kind !== 'worktree' && kind !== 'branch' && !RESIDUE_KINDS.has(kind as ResidueKind)) {
    throw new Error(
      `unknown reclaim kind ${JSON.stringify(kind)}: use worktree, branch, ref-guard, sandbox, retained-ref, trust, process, stale-run, or fixture-questions`,
    )
  }
  const result = reclaimNamed(kind, subject, dryRun)
  if (!result.ok) throw new Error(result.action)
  presentation.log(result.action)
}
