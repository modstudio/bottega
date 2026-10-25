/** Versioned envelope shared by the gate-facts writer and older branch readers. */
export const GATE_FACTS_FORMAT_VERSION = 1

export function assertGateFactsFormat(text: string): void {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`gate facts are not valid JSON: ${String((cause as Error).message ?? cause)}`)
  }
  const version =
    typeof value === 'object' && value !== null
      ? (value as { formatVersion?: unknown }).formatVersion
      : undefined
  if (version !== GATE_FACTS_FORMAT_VERSION) {
    throw new Error(
      `unknown gate-facts format version ${String(version)}; this branch reads version ${GATE_FACTS_FORMAT_VERSION}`,
    )
  }
}
