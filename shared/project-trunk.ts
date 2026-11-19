/** Return the normalized landing branch only when settings declare one. */
export function declaredTrunk(settings: { trunk?: unknown }): string | null {
  return typeof settings.trunk === 'string' && settings.trunk.trim() ? settings.trunk.trim() : null
}
