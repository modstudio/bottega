import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherRepositoryFactsReport, type RepositoryGitRunner } from './repository-facts.ts'

let directory = ''
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'setup-repository-'))
  writeFileSync(join(directory, 'package.json'), '{"dependencies":{"react":"latest"}}')
  for (const args of [
    ['init', '--initial-branch=main'],
    ['config', 'user.email', 'setup@example.invalid'],
    ['config', 'user.name', 'Setup Test'],
    ['add', 'package.json'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: directory, stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
})

function fakeGit(origins: Map<string, string>, timedOutPath: string): RepositoryGitRunner {
  return (path, args) => {
    const command = args.join(' ')
    if (command === 'rev-parse --show-toplevel') {
      return { exitCode: 0, stdout: realpathSync(path), timedOut: false }
    }
    if (command === 'remote get-url origin') {
      return {
        exitCode: 0,
        stdout: origins.get(path) ?? '',
        timedOut: false,
      }
    }
    if (command === 'symbolic-ref --quiet --short HEAD') {
      return { exitCode: 0, stdout: 'main', timedOut: false }
    }
    if (command === 'status --porcelain') {
      return { exitCode: 0, stdout: '', timedOut: path === timedOutPath }
    }
    return { exitCode: 1, stdout: '', timedOut: false }
  }
}

test('strips every origin credential form and reports an injected inspection timeout', () => {
  const repositories = ['https-origin', 'ssh-origin', 'scp-origin'].map((name) => {
    const path = join(directory, name)
    mkdirSync(path)
    return realpathSync(path)
  })
  const origins = new Map([
    [repositories[0]!, 'https://fake-user:fake-password@example.com/owner/repo.git'],
    [repositories[1]!, 'ssh://fake-token@example.com/owner/repo.git'],
    [repositories[2]!, 'fake-token@example.com:owner/repo.git'],
  ])
  const report = gatherRepositoryFactsReport(
    repositories,
    fakeGit(origins, repositories[1]!),
    () => null,
  )
  const output = JSON.stringify(report)
  expect(output).not.toContain('fake-user')
  expect(output).not.toContain('fake-password')
  expect(output).not.toContain('fake-token')
  expect(report.repositories.map((facts) => facts.originHost)).toEqual([
    'example.com',
    'example.com',
    'example.com',
  ])
  expect(report.repositories[1]?.inspectionTimedOut).toBe(true)
  for (const path of repositories) rmSync(path, { recursive: true })
})

test('reports a timed out repository discovery instead of silently omitting it', () => {
  const report = gatherRepositoryFactsReport([directory], (_path, args) => ({
    exitCode: 1,
    stdout: '',
    timedOut: args.join(' ') === 'rev-parse --show-toplevel',
  }))
  expect(report.repositories).toEqual([])
  expect(report.notices[0]?.message).toContain('timed out')
  expect(report.notices[0]?.message).toContain(directory.split('/').at(-1) ?? directory)
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('detects facts from a temporary git repository', () => {
  expect(gatherRepositoryFactsReport([directory]).repositories).toEqual([
    expect.objectContaining({
      path: realpathSync(directory),
      currentBranch: 'main',
      clean: true,
      originUrl: null,
      originHost: null,
      remoteDefaultBranch: null,
      stack: 'node-react',
    }),
  ])
})
