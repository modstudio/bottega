/** Joins class names, dropping empty entries. */
export function classes(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}
