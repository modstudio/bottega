// concern: GitHub Actions API
/** Lists GitHub Actions workflow runs through one paged CLI port. */

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

function run(cwd: string, argv: string[]): ProcessResult {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

export function githubApi(cwd: string, path: string, fields: readonly string[] = []): unknown {
  const result = run(cwd, [
    'gh',
    'api',
    '--method',
    'GET',
    path,
    ...fields.flatMap((field) => ['-f', field]),
  ])
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${result.stderr || `exit ${result.exitCode}`}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(
      `gh api ${path} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export function githubArray(value: unknown, field?: string): unknown[] {
  const selected =
    field && value && typeof value === 'object' ? (value as Record<string, unknown>)[field] : value
  if (!Array.isArray(selected))
    throw new Error(`GitHub API returned an unexpected ${field ?? 'array'} shape`)
  return selected
}

export function githubWorkflowRuns(
  cwd: string,
  repository: string,
  query: { branch?: string; event?: string; created: string },
): unknown[] {
  const values: unknown[] = []
  for (let page = 1; ; page += 1) {
    const fields = ['per_page=100', `page=${page}`]
    if (query.branch) fields.push(`branch=${query.branch}`)
    if (query.event) fields.push(`event=${query.event}`)
    fields.push(`created=${query.created}`)
    const batch = githubArray(
      githubApi(cwd, `repos/${repository}/actions/runs`, fields),
      'workflow_runs',
    )
    values.push(...batch)
    if (batch.length < 100) break
  }
  return values
}
