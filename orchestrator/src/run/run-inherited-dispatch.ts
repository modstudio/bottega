// concern: inherited run dispatch
/** Reads the first-turn options that later turns inherit. */

import { readDispatchState } from './run-artifacts.ts'
import type { RunOptions } from './run-options.ts'
import { resumeFacts } from './run-resume-kind.ts'

export function inheritedRunDispatch(opts: RunOptions) {
  const prior = opts.resume
  const resume = resumeFacts(prior?.kind ?? null, opts.reserveId ?? '', prior?.parent ?? null)
  const dispatch = resume.workspaceSource === 'retained' ? readDispatchState(prior!.parent) : null
  return {
    resume,
    declaredDeliverables: opts.deliverables ?? dispatch?.deliverables ?? [],
    timeoutMinutes: opts.timeoutMinutes ?? dispatch?.timeoutMinutes ?? undefined,
  }
}
