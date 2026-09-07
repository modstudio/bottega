import { describe, expect, test } from 'bun:test'

const cli = new URL('./cli.ts', import.meta.url).pathname

function run(command: 'jobs' | 'agents', json = false) {
  const proc = Bun.spawnSync([process.execPath, cli, command, ...(json ? ['--json'] : [])], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
  })
  expect(proc.exitCode).toBe(0)
  return proc.stdout.toString()
}

describe('inspectable catalogs', () => {
  test('jobs --json projects the inspectable job fields without changing human output', () => {
    const rows = JSON.parse(run('jobs', true)) as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toEqual(expect.objectContaining({
      name: expect.any(String), what: expect.any(String), needs: expect.any(Object),
      prefer: expect.any(Array), contextTokens: expect.any(Number),
    }))
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'contextTokens', 'findings', 'name', 'needs', 'prefer', 'timeoutCeilingMs', 'timeoutMs', 'what',
    ])
    expect(run('jobs')).toContain(' [axes delivery,quality]')
  })

  test('agents --json exposes only the inspectable agent fields', () => {
    const rows = JSON.parse(run('agents', true)) as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toEqual(expect.objectContaining({
      name: expect.any(String), caps: expect.any(Object), model: expect.any(String),
      timeoutMs: expect.any(Number),
    }))
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'caps', 'contextTokens', 'maxPromptBytes', 'model', 'name', 'timeoutMs',
    ])
  })
})
