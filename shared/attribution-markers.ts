import markerPatterns from './attribution-markers.json'

const ATTRIBUTION_MARKER_PATTERNS: readonly string[] = markerPatterns

const attributionMarker = new RegExp(ATTRIBUTION_MARKER_PATTERNS.join('|'), 'iu')

export type AttributionFinding = {
  line: number
  text: string
}

/** Return only lines that make an attribution claim; ordinary AI discussion is allowed. */
export function attributionFindings(text: string): AttributionFinding[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      attributionMarker.test(line) ? [{ line: index + 1, text: line }] : [],
    )
}
