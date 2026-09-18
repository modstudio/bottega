// concern: job-commands
/** Owns job catalogue presentation. Must not know CLI grammar. */
import { JOBS } from './jobs.ts'

export function jobsPayload() {
  return Object.values(JOBS).map((entry) => ({
    name: entry.name,
    what: entry.what,
    needs: entry.needs,
    prefer: entry.prefer,
    contextTokens: entry.contextTokens,
    timeoutMs: entry.timeoutMs ?? null,
    timeoutCeilingMs: entry.timeoutCeilingMs ?? null,
    findings: Boolean(entry.findings),
  }))
}

export function jobsCommand(json: boolean, presentation: { log(value: string): void }): void {
  if (json) {
    presentation.log(JSON.stringify(jobsPayload()))
    return
  }
  for (const entry of Object.values(JOBS)) {
    const truthyNeeds = Object.entries(entry.needs)
      .filter(([, needed]) => needed)
      .map(([need]) => need)
    const needs = truthyNeeds.length ? ` [needs ${truthyNeeds.join(',')}]` : ''
    const inline = entry.needs.readsRepo === false ? ' [inline]' : ''
    const axes = entry.needs.writesRepo
      ? ' [axes delivery,quality,fidelity]'
      : ' [axes delivery,quality]'
    presentation.log(`${entry.name.padEnd(15)} ${entry.what}${needs}${inline}${axes}`)
  }
}
