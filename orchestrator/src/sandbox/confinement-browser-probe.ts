// concern: headless-browser confinement probe; resolves an installed shell and launches it in SRT.

import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { startBounded } from '../../../shared/bounded-process.ts'
import { resetSandbox, type SandboxRuntimeConfig, sandboxLaunchArgv } from './sandbox.ts'

type DirectoryListing = (directory: string) => readonly string[]

type HeadlessShellInput = {
  platform: string
  homeDirectory: string
  playwrightBrowsersPath: string | undefined
  listDirectory: DirectoryListing
}

type BrowserProbeVerdictInput = {
  executable: string | null
  exitCode: number
  stdout: string
  stderr?: string
}

type BrowserProbeVerdict = {
  status: 'ran' | 'failed' | 'not covered'
  reason?: string
}

function listed(directory: string, listDirectory: DirectoryListing): readonly string[] {
  try {
    return listDirectory(directory)
  } catch {
    return []
  }
}

function listedExecutable(
  buildDirectory: string,
  relativeDirectory: string,
  listDirectory: DirectoryListing,
): string | null {
  const directory = join(buildDirectory, relativeDirectory)
  return listed(directory, listDirectory).includes('chrome-headless-shell')
    ? join(directory, 'chrome-headless-shell')
    : null
}

function headlessShellCacheRoot(input: HeadlessShellInput): string | null {
  if (input.platform !== 'darwin' && input.platform !== 'linux') return null
  const configuredRoot = input.playwrightBrowsersPath
  if (configuredRoot && configuredRoot !== '0') {
    return isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(input.homeDirectory, configuredRoot)
  }
  return input.platform === 'darwin'
    ? join(input.homeDirectory, 'Library', 'Caches', 'ms-playwright')
    : join(input.homeDirectory, '.cache', 'ms-playwright')
}

function installedHeadlessShellBuilds(root: string, listDirectory: DirectoryListing) {
  return listed(root, listDirectory)
    .flatMap((name) => {
      const match = /^chromium_headless_shell-(\d+)$/.exec(name)
      return match ? [{ name, revision: Number(match[1]) }] : []
    })
    .sort((left, right) => right.revision - left.revision)
}

function executableInBuild(
  buildDirectory: string,
  platform: string,
  listDirectory: DirectoryListing,
): string | null {
  if (platform === 'linux') {
    return listedExecutable(buildDirectory, 'chrome-headless-shell-linux64', listDirectory)
  }
  return (
    listedExecutable(buildDirectory, 'chrome-headless-shell-mac-arm64', listDirectory) ??
    listedExecutable(buildDirectory, 'chrome-headless-shell-mac-x64', listDirectory)
  )
}

/** Resolve the newest installed Playwright headless-shell executable without reading ambient state. */
export function headlessShellExecutable(input: HeadlessShellInput): string | null {
  const root = headlessShellCacheRoot(input)
  if (root === null) return null
  for (const build of installedHeadlessShellBuilds(root, input.listDirectory)) {
    const executable = executableInBuild(
      join(root, build.name),
      input.platform,
      input.listDirectory,
    )
    if (executable) return executable
  }
  return null
}

function firstErrorLine(stderr: string | undefined): string {
  return stderr?.trim().split(/\r?\n/, 1)[0] || 'no stderr'
}

/** Classify the browser launch without treating an absent executable as a pass. */
export function browserProbeVerdict(input: BrowserProbeVerdictInput): BrowserProbeVerdict {
  if (input.executable === null) {
    return {
      status: 'not covered',
      reason:
        'no Playwright chrome-headless-shell installed (npx playwright install chromium-headless-shell)',
    }
  }
  if (input.exitCode === 0 && input.stdout.includes('<body')) return { status: 'ran' }
  return {
    status: 'failed',
    reason: `exit ${input.exitCode}: ${firstErrorLine(input.stderr)}`,
  }
}

/** Launch the installed shell through the unmodified read-only SRT profile. */
export async function launchHeadlessBrowserProbe(
  profile: SandboxRuntimeConfig,
  scratchDir: string,
  environment: Record<string, string>,
) {
  const executable = headlessShellExecutable({
    platform: process.platform,
    homeDirectory: homedir(),
    playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
    listDirectory: (directory) => readdirSync(directory),
  })
  if (executable === null) {
    return {
      family: 'headless browser' as const,
      ...browserProbeVerdict({ executable, exitCode: 0, stdout: '' }),
      paths: {},
    }
  }

  const profileDirectory = join(scratchDir, 'headless-browser-profile')
  const temporaryDirectory = join(scratchDir, 'headless-browser-tmp')
  try {
    mkdirSync(profileDirectory, { recursive: true })
    mkdirSync(temporaryDirectory, { recursive: true })
    const argv = await sandboxLaunchArgv(
      profile,
      executable,
      [
        '--single-process',
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${profileDirectory}`,
        '--dump-dom',
        'about:blank',
      ],
      scratchDir,
      environment,
    )
    const result = await startBounded(argv, {
      budget: 'sandbox-probe',
      env: { ...process.env, ...environment, TMPDIR: temporaryDirectory },
    })
    return {
      family: 'headless browser' as const,
      ...browserProbeVerdict({ executable, ...result }),
      paths: {},
    }
  } catch (error) {
    return {
      family: 'headless browser' as const,
      status: 'failed' as const,
      paths: {},
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await resetSandbox()
  }
}
