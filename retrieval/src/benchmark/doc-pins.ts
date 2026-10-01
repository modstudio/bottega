// concern: retrieval-benchmark
/** Decides whether benchmark provenance pins still occur in their current document bodies. */

import { type DocRow, docIdentity } from '../corpus/chunks.ts'
import type { DocBenchmarkQuery } from './queries.ts'

export type DocPinResult = {
  queryId: string
  doc: string
  docSlug: string
  excerpt: string
  revision: string | null
  current: boolean
}

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

/** Compare provenance after whitespace normalization only. */
export function checkDocPins(
  pins: readonly DocBenchmarkQuery[],
  bodies: readonly DocRow[],
): DocPinResult[] {
  const docs = new Map(
    bodies.map((body) => [
      docIdentity({ scope: body.scope, subject: body.subject, slug: body.slug }),
      body,
    ]),
  )
  return pins.map((pin) => {
    const body = docs.get(pin.provenance.doc)
    return {
      queryId: pin.id,
      doc: pin.provenance.doc,
      docSlug: body?.slug ?? pin.provenance.doc.split('/').at(-1) ?? pin.provenance.doc,
      excerpt: pin.provenance.excerpt,
      revision: body?.revision ?? null,
      current:
        body !== undefined &&
        normalizeWhitespace(body.body).includes(normalizeWhitespace(pin.provenance.excerpt)),
    }
  })
}
