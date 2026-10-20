// concern: orphan worktree processes
/** Separates process-table observation from the pure missing-tree decision. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { OrphanProcess } from '../resources/process-inventory.ts'
import type { MonitorCondition } from './monitor-types.ts'

export function orphanProcessConditions(
  inventory: { orphans: readonly OrphanProcess[]; error: string | null },
  clock: number,
): { conditions: MonitorCondition[]; errors: string[] } {
  return {
    errors: inventory.error ? [`process inventory unavailable: ${inventory.error}`] : [],
    conditions: inventory.orphans.map((process) => ({
      kind: 'orphan-worktree-process',
      subject: `pid:${process.pid}`,
      since: new Date(clock - process.ageSeconds * 1000).toISOString(),
      ageMs: process.ageSeconds * 1000,
      detail: `pid ${process.pid} ${process.command}; age ${process.ageSeconds}s; missing tree ${process.missingTree}; matched by ${process.match}${process.match === 'argument' ? '; argument-only matches require manual reclaim' : ''}`,
      action: `run ${PLATFORM_SLUG} machine reclaim orphan-process ${process.pid} --dry-run, then ${PLATFORM_SLUG} machine reclaim orphan-process ${process.pid}`,
      affectedProject: process.project,
    })),
  }
}
