// concern: retrieval-benchmark
/** Decides whether benchmark provenance pins still occur in their repository files. */

import type { BenchmarkQuery } from './queries.ts'

export type CodePinSource = { path: string; body: string }
export type CodePinResult = {
  queryId: string
  path: string
  excerpt: string
  current: boolean
}

const normalizeSource = (value: string) => value.replace(/[`*_]/g, '').replace(/\s+/g, ' ')
const normalizeExcerpt = (value: string) => value.replace(/\s+/g, ' ')

/** Compare code provenance with the benchmark's whitespace and markdown normalization. */
export function checkCodePins(
  pins: readonly BenchmarkQuery[],
  sources: readonly CodePinSource[],
): CodePinResult[] {
  const bodies = new Map(sources.map((source) => [source.path, source.body]))
  return pins.map((pin) => ({
    queryId: pin.id,
    path: pin.provenance.path,
    excerpt: pin.provenance.excerpt,
    current:
      bodies.has(pin.provenance.path) &&
      normalizeSource(bodies.get(pin.provenance.path)!).includes(
        normalizeExcerpt(pin.provenance.excerpt),
      ),
  }))
}
