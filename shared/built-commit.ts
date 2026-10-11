export function parseBuiltCommit(raw: string | undefined): string | undefined {
  const commit = raw?.trim()
  return commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : undefined
}

export function readBuiltCommit(environment: Record<string, string | undefined> = process.env) {
  return parseBuiltCommit(environment.GIT_SHA)
}
