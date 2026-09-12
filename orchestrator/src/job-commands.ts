// concern: jobs
/** Owns job catalogue presentation. Must not know CLI grammar. */
import { JOBS } from './jobs.ts'

export function jobsCommand(json: boolean, presentation: { log(value: string): void }): void {
  if (json) {
    presentation.log(JSON.stringify(Object.values(JOBS).map((entry) => ({ name: entry.name, what: entry.what, needs: entry.needs, prefer: entry.prefer, contextTokens: entry.contextTokens, timeoutMs: entry.timeoutMs ?? null, timeoutCeilingMs: entry.timeoutCeilingMs ?? null, findings: Boolean(entry.findings) }))))
    return
  }
  for (const entry of Object.values(JOBS)) {
    const needs = Object.keys(entry.needs).length ? ` [needs ${Object.keys(entry.needs).join(',')}]` : ''
    const axes = entry.needs.writesRepo ? ' [axes delivery,quality,fidelity]' : ' [axes delivery,quality]'
    presentation.log(`${entry.name.padEnd(15)} ${entry.what}${needs}${axes}`)
  }
}
