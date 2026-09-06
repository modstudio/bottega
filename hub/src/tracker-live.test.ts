import { expect, test } from 'bun:test'

test('a project added in-process is fetched on the next scheduled slow pass', () => {
  const fixture = new URL('../test/tracker-live.fixture.ts', import.meta.url).pathname
  const proc = Bun.spawnSync(['bun', 'test', fixture], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)
  expect(proc.exitCode, `${stdout}\n${stderr}`).toBe(0)
})
