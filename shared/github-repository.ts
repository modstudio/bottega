/** Canonical lowercase owner/name for HTTPS, SSH URL, and SCP-like GitHub addresses. */
export function githubRepository(value: string | null): string | null {
  if (!value) return null
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    )
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}
