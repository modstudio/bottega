// concern: GitHub Actions API
/** Owns the gh process port for Actions run listings and merge-queue GraphQL. */

import { targetGitEnvironment } from '../git/git-environment.ts'

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

function run(cwd: string, argv: string[]): ProcessResult {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

export function githubCommand(cwd: string, argv: string[], label: string): string {
  const result = run(cwd, ['gh', ...argv])
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}

function githubJson(cwd: string, argv: string[], label: string): unknown {
  const output = githubCommand(cwd, argv, label)
  try {
    return JSON.parse(output)
  } catch (cause) {
    throw new Error(
      `${label} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export function githubApi(cwd: string, path: string, fields: readonly string[] = []): unknown {
  return githubJson(
    cwd,
    ['api', '--method', 'GET', path, ...fields.flatMap((field) => ['-f', field])],
    `gh api ${path}`,
  )
}

export function githubGraphql(
  cwd: string,
  query: string,
  fields: readonly string[],
  label: string,
): unknown {
  return githubJson(
    cwd,
    ['api', 'graphql', '-f', `query=${query}`, ...fields.flatMap((field) => ['-f', field])],
    label,
  )
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
