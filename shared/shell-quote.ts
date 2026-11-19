// concern: shell-quote
/** Quotes one value for display in a pasteable POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
