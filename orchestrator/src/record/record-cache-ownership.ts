// concern: record-cache-ownership
/** Pure tenant ownership for one local document-cache address. */

import { docWriteProjectName } from '../doc/doc-write-allowed.ts'

export function recordCacheAddressOwner(input: {
  scope: string
  subject: string | null
  activeSpaceId: string
  projectSpaces: ReadonlyMap<string, string | null>
}): string | null {
  const projectName = docWriteProjectName(input.scope, input.subject)
  return projectName && input.projectSpaces.has(projectName)
    ? (input.projectSpaces.get(projectName) ?? null)
    : input.activeSpaceId
}

export function recordCacheSpaceOwnsAddress(input: {
  scope: string
  subject: string | null
  pullingSpaceId: string
  activeSpaceId: string
  projectSpaces: ReadonlyMap<string, string | null>
}): boolean {
  return recordCacheAddressOwner(input) === input.pullingSpaceId
}
