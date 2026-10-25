// concern: sealed-value
/** One definition of a piped or sealed secret value: its trailing newline and its emptiness. */

/** Strip the single trailing newline a piped value carries. */
export function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, '')
}

/** Whether a sealed value is empty: blank after the trailing-newline strip. */
export function sealedValueIsEmpty(value: string): boolean {
  return stripTrailingNewline(value).trim() === ''
}
