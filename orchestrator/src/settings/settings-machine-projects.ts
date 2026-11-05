// concern: settings-machine-projects
/** Filesystem and Git adapters for project-scoped Claude settings. */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitAt, gitToplevel } from '../../../shared/git.ts'
import { nulPathListArgs } from '../../../shared/git-path-list.ts'
import type { OwnedSettings } from './settings.ts'
import { projectLocalSettingsPath, readSettingsFile } from './settings-files.ts'
import { renderScopedSettingsFile } from './settings-render.ts'
import { applySettingsWrite, planSettingsWrite } from './settings-write.ts'

export function registeredProjectScopeFact(path: string): {
  path: string
  exists: boolean
  gitMainCheckout: boolean
} {
  if (!existsSync(path)) return { path, exists: false, gitMainCheckout: false }
  const top = gitToplevel(path)
  const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const main =
    top !== null && common !== null && resolve(common) === join(realpathSync(top), '.git')
  return { path, exists: true, gitMainCheckout: main }
}

function ensureProjectLocalSettingsIgnored(project: string): void {
  const target = '.claude/settings.local.json'
  if (projectLocalSettingsIgnored(project)) return
  const common = git(project, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) throw new Error(`could not resolve Git common directory for ${project}`)
  const exclude = join(common, 'info', 'exclude')
  mkdirSync(dirname(exclude), { recursive: true })
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  appendFileSync(exclude, `${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${target}\n`)
}

function projectLocalSettingsIgnored(project: string): boolean {
  const target = '.claude/settings.local.json'
  if (git(project, nulPathListArgs(['ls-files', '--error-unmatch', '--', target])) !== null) {
    throw new Error(`refusing to edit tracked settings file ${join(project, target)}`)
  }
  return git(project, ['check-ignore', '-q', '--', target], true) !== null
}

export function applyProjectLocalSettings(input: {
  project: string
  owned: OwnedSettings
  environment: Record<string, string>
  scope: 'project' | 'none'
  check: boolean
  stateEnvironment: NodeJS.ProcessEnv
}): { changed: boolean; detail?: string } {
  const path = projectLocalSettingsPath(input.project)
  const present = existsSync(path)
  const current = present ? readSettingsFile(path).text : '{}\n'
  const rendered = renderScopedSettingsFile(current, input.owned, input.environment, input.scope)
  const ignored =
    input.scope === 'none' && current === rendered
      ? true
      : projectLocalSettingsIgnored(input.project)
  if (current === rendered && ignored) return { changed: false }
  if (input.check) return { changed: true, detail: 'would apply' }
  ensureProjectLocalSettingsIgnored(input.project)
  if (current === rendered) return { changed: true, detail: 'updated Git info/exclude' }
  mkdirSync(dirname(path), { recursive: true })
  if (!present) writeFileSync(path, '{}\n', { flag: 'wx', mode: 0o600 })
  const result = applySettingsWrite(planSettingsWrite(path, rendered), input.stateEnvironment)
  return {
    changed: result.written,
    detail: present && result.backup ? `backup ${result.backup}` : 'created new file',
  }
}

function git(cwd: string, args: string[], quiet = false): string | null {
  const result = gitAt(cwd, args)
  if (result.code !== 0) return null
  return quiet ? '' : result.stdout.trim()
}
