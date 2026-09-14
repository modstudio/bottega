import { scrubbedGitEnv } from '../../../shared/git.ts'
import {
  cloneRepository as cloneSharedRepository,
  templateRepository as sharedTemplateRepository,
} from '../../../shared/test-git-repository.ts'
import { dir, hermeticHome as preloadHome } from '../preload.ts'

export const gitEnvironmentVariables = Object.keys(process.env).filter((variable) =>
  variable.startsWith('GIT_'))
export const hermeticGitCommand =
  `env ${gitEnvironmentVariables.map((variable) => `-u ${variable}`).join(' ')} git`
export const hermeticHome = preloadHome
export const hermeticGitEnv = (extra: Record<string, string> = {}) => ({
  ...scrubbedGitEnv(), HOME: hermeticHome,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra,
})

export function templateRepository(): string {
  return sharedTemplateRepository(hermeticGitEnv(), dir)
}

export function cloneRepository(name = 'git-clone-'): string {
  templateRepository()
  return cloneSharedRepository(hermeticGitEnv(), name)
}
