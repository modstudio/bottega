// concern: monitor-retrieval-pins
/** Runs the model-free retrieval pin report and translates stale pins into monitor conditions. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { optionalCheckoutRoot } from '../../../shared/install-root.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { MonitorCondition } from './monitor-types.ts'

type RetrievalPinObservation = {
  conditions: MonitorCondition[]
  errors: string[]
  notApplicable: string[]
}

type CheckoutRootLookup = () => string | null
type ChildRunner = typeof startBoundedSync

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

function childErrorTail(stderr: string, exitCode: number): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? `exit ${exitCode}`
}

export function observeRetrievalPins(
  checkoutRoot: CheckoutRootLookup = () => optionalCheckoutRoot(process.cwd(), process.env),
  runChild: ChildRunner = startBoundedSync,
): RetrievalPinObservation {
  try {
    if (checkoutRoot() === null) {
      return {
        conditions: [],
        errors: [],
        notApplicable: [
          'retrieval benchmark pin observation not applicable: this install has no source checkout, and document pin checking needs its benchmark fixtures',
        ],
      }
    }
    const child = runChild([...bottegaEntryArgv('retrieval-search'), '--check-doc-pins'], {
      budget: 'self-cli',
    })
    let value: unknown
    try {
      value = JSON.parse(child.stdout) as unknown
    } catch {
      throw new Error(
        `${childErrorTail(child.stderr, child.exitCode)}; cleared by: inspect the full child output with ${PLATFORM_SLUG} __retrieval-search --check-doc-pins`,
      )
    }
    if (child.exitCode !== 0 && child.exitCode !== 1) {
      throw new Error(childErrorTail(child.stderr, child.exitCode))
    }
    const report = parsePinReport(value)
    return { conditions: staleRetrievalPinConditions(report), errors: [], notApplicable: [] }
  } catch (cause) {
    return {
      conditions: [],
      errors: [
        `retrieval benchmark pin observation unavailable: ${String((cause as Error).message ?? cause)}`,
      ],
      notApplicable: [],
    }
  }
}
