// concern: project-agent-keys
/** Validates project-owned agent secret mappings without knowing register storage. */

export function projectAgentKeyProblems(value: unknown): string[] {
  if (value === undefined) return []
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([agentSecret, projectSecret]) =>
        !agentSecret.trim() ||
        agentSecret !== agentSecret.trim() ||
        typeof projectSecret !== 'string' ||
        !projectSecret.trim() ||
        projectSecret !== projectSecret.trim(),
    )
  ) {
    return [
      'agentKeys must be an object mapping non-empty trimmed agent secret names to non-empty trimmed project secret names',
    ]
  }
  return []
}
