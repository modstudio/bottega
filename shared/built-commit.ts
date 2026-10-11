export function parseBuiltCommit(raw: string | undefined): string | undefined {
  const commit = raw?.trim()
  return commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : undefined
}

export function readBuiltCommit(environment: Record<string, string | undefined> = process.env) {
  return parseBuiltCommit(environment.GIT_SHA)
}

export function builtCommitResponse(commit: string | undefined) {
  return commit
    ? { status: 200 as const, body: { commit } }
    : {
        status: 503 as const,
        body: { commit: null, error: 'the commit this app was built from is unknown' },
      }
}
