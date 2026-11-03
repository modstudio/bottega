import { createHash } from 'node:crypto'

/** Identifies a prompt by the first sixteen hex digits of its sha256, the form every run row records. */
export const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
