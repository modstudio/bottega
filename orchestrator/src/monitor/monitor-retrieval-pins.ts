// concern: monitor-retrieval-pins
/** Runs the model-free retrieval pin report and translates stale pins into monitor conditions. */

import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { MonitorCondition } from './monitor-types.ts'

// The model-free local store read normally completes in well under a second.
const RETRIEVAL_PIN_OBSERVATION_TIMEOUT_MS = 30_000

type PinReport = {
  pins: Array<{
    queryId: string
    doc: string
    docSlug: string
    excerpt: string
    revision: string | null
    current: boolean
  }>
}

function parsePinReport(value: unknown): PinReport {
  if (!value || typeof value !== 'object' || !Array.isArray((value as PinReport).pins)) {
    throw new Error('pin report was not an object with a pins array')
  }
  const report = value as PinReport
  for (const pin of report.pins) {
    if (
      !pin ||
      typeof pin.queryId !== 'string' ||
      typeof pin.doc !== 'string' ||
      typeof pin.docSlug !== 'string' ||
      typeof pin.excerpt !== 'string' ||
      (typeof pin.revision !== 'string' && pin.revision !== null) ||
      typeof pin.current !== 'boolean'
    ) {
      throw new Error('pin report contained an invalid result')
    }
  }
  return report
}

export function staleRetrievalPinConditions(report: PinReport): MonitorCondition[] {
  return report.pins
    .filter((pin) => !pin.current)
    .map((pin) => ({
      kind: 'stale-retrieval-benchmark-pin',
      subject: pin.queryId,
      since: null,
      ageMs: null,
      detail: `${pin.queryId} excerpt is absent from ${pin.docSlug} at revision ${pin.revision ?? 'unknown'}: ${JSON.stringify(pin.excerpt)}`,
      action: `repin ${pin.queryId} by hand in retrieval/src/benchmark/queries.ts after deciding what the query should retrieve`,
    }))
}

export function observeRetrievalPins(): { conditions: MonitorCondition[]; errors: string[] } {
  const child = Bun.spawnSync([...bottegaEntryArgv('retrieval-search'), '--check-doc-pins'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: RETRIEVAL_PIN_OBSERVATION_TIMEOUT_MS,
  })
  const stdout = new TextDecoder().decode(child.stdout)
  const stderr = new TextDecoder().decode(child.stderr).trim()
  try {
    if (child.exitedDueToTimeout) {
      throw new Error(`timed out after ${RETRIEVAL_PIN_OBSERVATION_TIMEOUT_MS}ms`)
    }
    if (child.exitCode !== 0 && child.exitCode !== 1) {
      throw new Error(stderr || `exit ${child.exitCode}`)
    }
    const report = parsePinReport(JSON.parse(stdout) as unknown)
    return { conditions: staleRetrievalPinConditions(report), errors: [] }
  } catch (cause) {
    return {
      conditions: [],
      errors: [
        `retrieval benchmark pin observation unavailable: ${String((cause as Error).message ?? cause)}`,
      ],
    }
  }
}
