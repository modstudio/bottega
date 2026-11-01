// concern: outbox-serialization
/** Serializes one local outbox payload after refusing strings PostgreSQL cannot accept. */

function objectPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

function firstNulPath(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') return value.includes('\0') ? path : null
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = firstNulPath(child, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    const childPath = objectPath(path, key)
    if (key.includes('\0')) return childPath
    const found = firstNulPath(child, childPath)
    if (found) return found
  }
  return null
}

export function serializeOutboxPayload(kind: string, payload: unknown): string {
  const offendingPath = firstNulPath(payload)
  if (offendingPath) {
    throw new Error(
      `outbox ${kind} payload contains U+0000 at ${offendingPath}; split or replace the separator before enqueue`,
    )
  }
  return JSON.stringify(payload)
}
