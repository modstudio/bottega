import { afterEach } from 'bun:test'
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import { dir, hermeticHome as preloadHome, testSpawnSync } from '../preload.ts'

export const gitEnvironmentVariables = Object.keys(process.env).filter((variable) =>
  variable.startsWith('GIT_'))
export const hermeticGitCommand =
  `env ${gitEnvironmentVariables.map((variable) => `-u ${variable}`).join(' ')} git`
export const hermeticHome = preloadHome
export const hermeticGitEnv = (extra: Record<string, string> = {}) => ({
  ...scrubbedGitEnv(), HOME: hermeticHome,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra,
})

const git = (cwd: string, ...args: string[]): void => {
  const result = testSpawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

let template: string | undefined
const clones = new Set<string>()

afterEach(() => {
  for (const clone of clones) rmSync(clone, { recursive: true, force: true })
  clones.clear()
})

export function templateRepository(): string {
  if (template) return template
  template = mkdtempSync(join(dir, 'git-template-'))
  git(template, 'init', '-b', 'main')
  git(template, 'config', 'user.email', 'orch-test@example.invalid')
  git(template, 'config', 'user.name', 'Orch Test')
  writeFileSync(join(template, 'base.txt'), 'base\n')
  git(template, 'add', 'base.txt')
  git(template, 'commit', '-m', 'base')
  return template
}

export function cloneRepository(name = 'git-clone-'): string {
  const target = mkdtempSync(join(tmpdir(), name))
  rmSync(target, { recursive: true })
  cpSync(templateRepository(), target, { recursive: true })
  const clone = realpathSync(target)
  clones.add(clone)
  return clone
}
