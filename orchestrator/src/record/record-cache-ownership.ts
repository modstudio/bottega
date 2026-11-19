// concern: record-cache-ownership
/** Pure tenant ownership for one local document-cache address. */

import { docWriteProjectName } from '../doc/doc-write-allowed.ts'

export function recordCacheProjectOwner(
  project: string,
  activeSpaceId: string,
  projectSpaces: ReadonlyMap<string, string | null>,
): string | null {
  return projectSpaces.has(project) ? (projectSpaces.get(project) ?? null) : activeSpaceId
}

export function recordCacheAddressOwner(input: {
  scope: string
  subject: string | null
  activeSpaceId: string
  projectSpaces: ReadonlyMap<string, string | null>
}): string | null {
  const projectName = docWriteProjectName(input.scope, input.subject)
  return projectName
    ? recordCacheProjectOwner(projectName, input.activeSpaceId, input.projectSpaces)
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

export function recordCacheSpaceOwnsSubject(
  project: string,
  space: string,
  projectSpaces: ReadonlyMap<string, string | null>,
): boolean {
  return projectSpaces.get(project) === space
}
