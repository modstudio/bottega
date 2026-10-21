import { identifierStyles } from './identifier.styles.ts'

/**
 * An identifier as written: a task key, run id, hash or commit. Set in the mono
 * face so identifiers align and read as names rather than words.
 */
export function Identifier({ children, className }: { children: string; className?: string }) {
  return <span className={identifierStyles({ class: className })}>{children}</span>
}
