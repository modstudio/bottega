import { afterAll, afterEach } from 'bun:test'
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let template: string | undefined
const clones = new Set<string>()

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  runTestGit(cwd, env, ...args)
}

export function runTestGit(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

afterEach(() => {
  for (const clone of clones) rmSync(clone, { recursive: true, force: true })
  clones.clear()
})

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true })
  template = undefined
})

function templateRepository(env: NodeJS.ProcessEnv, root = tmpdir()): string {
  if (template) return template
  template = mkdtempSync(join(root, 'git-template-'))
  git(template, env, 'init', '-b', 'main')
  git(template, env, 'config', 'user.email', 'orch-test@example.invalid')
  git(template, env, 'config', 'user.name', 'Orch Test')
  writeFileSync(join(template, 'base.txt'), 'base\n')
  git(template, env, 'add', 'base.txt')
  git(template, env, 'commit', '-m', 'base')
  return template
}

export function cloneRepository(env: NodeJS.ProcessEnv, name = 'git-clone-'): string {
  const target = mkdtempSync(join(tmpdir(), name))
  rmSync(target, { recursive: true })
  cpSync(templateRepository(env), target, { recursive: true })
  const clone = realpathSync(target)
  clones.add(clone)
  return clone
}
