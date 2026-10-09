export const RELEASE_TAG_SHAPE = 'v*'

/** Return the version named by a release tag, or null when the tag is not a release tag. */
export function releaseTagVersion(tag: string): string | null {
  return /^v[0-9A-Za-z][0-9A-Za-z.-]*$/.test(tag) ? tag.slice(1) : null
}
