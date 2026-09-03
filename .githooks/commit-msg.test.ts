import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook = join(import.meta.dir, 'commit-msg')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(message: string) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-msg-'))
  dirs.push(dir)
  const file = join(dir, 'COMMIT_EDITMSG')
  writeFileSync(file, message)
  const p = Bun.spawnSync(['sh', hook, file], { stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, stderr: p.stderr.toString(), stdout: p.stdout.toString() }
}

test('a subject with a DEV- key succeeds', () => {
  const r = run('DEV-1105 refuse a subject with no task key\n')
  expect(r.code).toBe(0)
  expect(r.stderr).toBe('')
})

test('a subject with no key is refused and names the fix', () => {
  const r = run('no key here\n')
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('commit-msg: subject must contain a DEV-<digits> task key')
  expect(r.stderr).toContain('hub task new --project bottega --title "..."')
})

test('a key in the body does not satisfy the check', () => {
  const r = run('no key in the subject\n\nDEV-1105 is only in the body\n')
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('DEV-<digits>')
})

test('merge, fixup, and squash subjects are exempt', () => {
  expect(run("Merge branch 'foo'\n").code).toBe(0)
  expect(run('fixup! no key here\n').code).toBe(0)
  expect(run('squash! no key here\n').code).toBe(0)
})

test('AI attribution is still refused', () => {
  const r = run('DEV-1105 otherwise fine\n\nCo-Authored-By: Claude\n')
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('commit-msg: AI attribution is not allowed in commit messages')
  expect(r.stderr).not.toContain('DEV-<digits>')
})

test('both checks fire when both fail', () => {
  const r = run('no key\n\nCo-Authored-By: Claude\n')
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('commit-msg: AI attribution is not allowed in commit messages')
  expect(r.stderr).toContain('commit-msg: subject must contain a DEV-<digits> task key')
})
