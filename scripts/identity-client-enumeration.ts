export function enumerateClientMethods(prefix: string, client: Record<string, unknown>): string[] {
  const methods = Object.entries(client)
    .filter(([, value]) => typeof value === 'function')
    .map(([method]) => `${prefix}.${method}`)
    .sort()
  if (!methods.length) throw new Error(`${prefix}: client method enumeration yielded no methods`)
  return methods
}
