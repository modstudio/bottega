import type { Finding } from '../../../shared/ratchet.ts'

const MEASURED_RULE = 'lint/complexity/noExcessiveLinesPerFunction'

type BiomeDiagnostic = {
  category?: unknown
  message?: unknown
  location?: { path?: unknown; start?: { line?: unknown } }
}

function functionLineMeasure(message: string): number {
  const value = Number(message.match(/too many lines \((\d+)\)/)?.[1])
  if (!Number.isFinite(value)) {
    throw new Error(`Biome function-length diagnostic carries no measure: ${message}`)
  }
  return value
}

export function biomeFindings(text: string): Finding[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const diagnostics = (value as { diagnostics?: unknown }).diagnostics
  if (!Array.isArray(diagnostics)) throw new Error('Biome output has no diagnostics array')
  return diagnostics.flatMap((raw: BiomeDiagnostic) => {
    const file = raw.location?.path
    const line = raw.location?.start?.line
    const rule = raw.category
    const message = raw.message
    if (typeof file !== 'string' || typeof line !== 'number' || typeof rule !== 'string') {
      throw new Error('Biome diagnostic has no file, line, or rule')
    }
    if (typeof message !== 'string') throw new Error('Biome diagnostic has no message')
    if (rule === 'lint/style/useNamingConvention' && message.includes('property name')) return []
    return [
      {
        file,
        line,
        rule,
        message,
        ...(rule === MEASURED_RULE ? { measure: functionLineMeasure(message) } : {}),
      },
    ]
  })
}
