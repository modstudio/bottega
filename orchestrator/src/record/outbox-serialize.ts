// concern: outbox-serialization
/** Serializes one local outbox payload after refusing U+0000 and lone surrogate code units. */

function objectPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

function isUnstorable(text: string): boolean {
  return text.includes('\0') || text !== text.toWellFormed()
}

function firstUnstorablePath(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') return isUnstorable(value) ? path : null
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = firstUnstorablePath(child, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    const childPath = objectPath(path, key)
    if (isUnstorable(key)) return childPath
    const found = firstUnstorablePath(child, childPath)
    if (found) return found
  }
  return null
}

export function serializeOutboxPayload(kind: string, payload: unknown): string {
  const offendingPath = firstUnstorablePath(payload)
  if (offendingPath) {
    throw new Error(
      `outbox ${kind} payload contains U+0000 or a lone surrogate at ${offendingPath}; sanitizeOutboxPayload should have replaced the value before enqueue`,
    )
  }
  return JSON.stringify(payload)
}
