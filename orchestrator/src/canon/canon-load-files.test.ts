import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { workerLaunchEnv } from '../agent/worker-launch-env.ts'
import { CLAUDE_FILE_MAX_BYTES, planHarnessLoad } from './canon-load.ts'
import { gatherHarnessLoadFacts } from './canon-load-files.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    const oversized = join(root, 'CLAUDE.md')
    if (existsSync(oversized)) chmodSync(oversized, 0o644)
    rmSync(root, { recursive: true, force: true })
  }
})

function gitInit(dir: string) {
  const result = Bun.spawnSync(['git', 'init'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: inspectionGitEnv({ ...process.env, HOME: dir }),
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'git init failed')
  }
}

test('an oversized file is skipped without being read', () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-load-oversize-'))
  roots.push(root)
  gitInit(root)
  const path = join(root, 'CLAUDE.md')
  const fd = openSync(path, 'w')
  ftruncateSync(fd, CLAUDE_FILE_MAX_BYTES + 1)
  closeSync(fd)
  chmodSync(path, 0o000)
  const home = join(root, 'home')
  mkdirSync(home)
  const facts = gatherHarnessLoadFacts(root, { HOME: home })
  const candidate = facts.files.find((file) => file.path.endsWith('/CLAUDE.md'))
  expect(candidate?.text).toBe('')
  expect(candidate?.skipped?.byteSize).toBe(CLAUDE_FILE_MAX_BYTES + 1)
  const plan = planHarnessLoad(facts, 'claude')
  expect(plan.files).toEqual([])
  expect(plan.skipped).toEqual([
    {
      path: candidate!.path,
      size: CLAUDE_FILE_MAX_BYTES + 1,
      reason: 'exceeds CLAUDE_FILE_MAX_BYTES',
    },
  ])
})

test('grok worker facts exclude the home Claude file', () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-load-worker-'))
  roots.push(root)
  gitInit(root)
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Architect instructions.')
  writeFileSync(join(root, 'CLAUDE.md'), 'Project instructions.')

  const facts = gatherHarnessLoadFacts(root, {
    HOME: home,
    GROK_CLAUDE_AGENTS_ENABLED: '1',
    ...workerLaunchEnv('grok'),
  })
  const plan = planHarnessLoad(facts, 'grok')

  expect(plan.files.map(({ path }) => path)).toContain(`${facts.directoryChain[0]}/CLAUDE.md`)
  expect(plan.files.map(({ path }) => path)).not.toContain(`${facts.home.claude}/CLAUDE.md`)
})
