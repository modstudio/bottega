/** Pure clonefile outcome policy, separate from the platform FFI adapter. */
import { constants } from 'node:os'
import { getSystemErrorName } from 'node:util'

export type CloneDirectoryOutcome =
  | { status: 'cloned' }
  | { status: 'unsupported'; errno: number | null; errnoName: string | null }
  | { status: 'failed'; errno: number; errnoName: string }

function errnoName(errno: number): string {
  try {
    return getSystemErrorName(-errno)
  } catch {
    return `ERRNO_${errno}`
  }
}

/** Map clonefile's errno to the only outcomes provisioning may act on. */
export function classifyClonefileErrno(
  errno: number,
): Exclude<CloneDirectoryOutcome, { status: 'cloned' }> {
  const name = errnoName(errno)
  return errno === constants.errno.ENOTSUP || errno === constants.errno.EXDEV
    ? { status: 'unsupported', errno, errnoName: name }
    : { status: 'failed', errno, errnoName: name }
}
