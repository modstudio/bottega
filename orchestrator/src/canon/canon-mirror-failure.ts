// concern: canon-mirror-failure
/** Preserves the publication failure when close-out also fails. */

export function composeMirrorFailure(original: string | null, cleanup: string): string {
  return original ? `${original}; ${cleanup}` : cleanup
}
