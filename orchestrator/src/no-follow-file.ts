// concern: no-follow-file
/** Exclusive file creation for paths in worker-writable directories. */

import { constants, openSync } from 'node:fs'

const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

export function createNoFollowFile(path: string): number {
  return openSync(path, CREATE_FLAGS, 0o600)
}
