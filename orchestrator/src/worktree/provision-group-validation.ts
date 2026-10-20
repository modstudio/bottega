// concern: pure provision declaration validation shared by tracked recipes and the project register

export type ProvisionGroupValidationEntry = {
  path: string
  method: 'link' | 'clone' | 'install'
  lockfile?: string
  install?: string
}

/** Validate rules that depend on every entry sharing one lockfile. */
export function validateProvisionGroups(
  entries: ProvisionGroupValidationEntry[],
  declaration: string,
): string[] {
  const groups = new Map<string, ProvisionGroupValidationEntry[]>()
  for (const entry of entries) {
    if (entry.lockfile === undefined) continue
    const group = groups.get(entry.lockfile) ?? []
    group.push(entry)
    groups.set(entry.lockfile, group)
  }

  const problems: string[] = []
  for (const [lockfile, group] of groups) {
    const installCommands = group
      .map((entry) => entry.install)
      .filter(
        (install): install is string => typeof install === 'string' && Boolean(install.trim()),
      )
    if (new Set(installCommands).size > 1) {
      problems.push(`${declaration} entries for lockfile "${lockfile}" must agree on install`)
    }

    const installPaths = group
      .filter((entry) => entry.method === 'install')
      .map((entry) => entry.path)
    const conflictingPaths = group
      .filter((entry) => entry.method !== 'install')
      .map((entry) => entry.path)
    if (installPaths.length > 0 && conflictingPaths.length > 0) {
      problems.push(
        `${declaration} entries for lockfile "${lockfile}" must not mix install paths [${installPaths.join(', ')}] with link or clone paths [${conflictingPaths.join(', ')}]`,
      )
    }
  }
  return problems
}
