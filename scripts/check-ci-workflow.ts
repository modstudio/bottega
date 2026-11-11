import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, CI_ONLY_JOBS, CI_ONLY_SUITES } from './check-plan.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const postgresServiceContainer = `BOTTEGA_TEST_POSTGRES_CONTAINER: \${{ job.services.postgres.id }}`
const playwrightPackageFiles = [
  'hub/ui/package.json',
  'hub/views/package.json',
  'hub/web/package.json',
] as const
const playwrightBrowserJobs = ['hub-web-smoke', 'hub-ui-stories'] as const
const playwrightBunInstallCommand = 'npm install --global "bun@$(cat .bun-version)"'
const playwrightTrustWorkspaceCommand =
  'git config --system --add safe.directory "$GITHUB_WORKSPACE"'

export function agreedPlaywrightDependencyPin(
  pins: readonly { file: string; pin: string | undefined }[],
): string {
  for (const { file, pin } of pins) {
    if (!pin) throw new Error(`${file} must pin the playwright devDependency`)
    if (!/^\d+\.\d+\.\d+$/.test(pin)) {
      throw new Error(
        `${file} pins playwright ${pin}; pin the exact version the Playwright image tag carries`,
      )
    }
  }
  const expected = pins[0]!.pin!
  const mismatch = pins.find(({ pin }) => pin !== expected)
  if (mismatch) {
    throw new Error(
      `${mismatch.file} pins playwright ${mismatch.pin}, but ${pins[0]!.file} pins ${expected}; set all three package.json playwright pins to the same version`,
    )
  }
  return expected
}

function playwrightDependencyPin(): string {
  return agreedPlaywrightDependencyPin(
    playwrightPackageFiles.map((file) => {
      const packageJson = JSON.parse(readFileSync(`${root}${file}`, 'utf8')) as {
        devDependencies?: Record<string, string>
      }
      return { file, pin: packageJson.devDependencies?.playwright }
    }),
  )
}

function workflowJobNames(source: string): string[] {
  const jobsStart = source.split('\n').indexOf('jobs:')
  if (jobsStart < 0) throw new Error('CI workflow has no jobs mapping')
  return source
    .split('\n')
    .slice(jobsStart + 1)
    .flatMap((line) => line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/)?.[1] ?? [])
}

function workflowJob(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start < 0) throw new Error(`CI workflow has no ${name} job`)
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(line),
  )
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

function workflowRunCommands(job: string): string[] {
  const lines = job.split('\n')
  const commands: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const run = /^(?<indent>\s*)(?:-\s+)?run:\s*(?<value>.*)$/.exec(lines[index]!)
    if (!run) continue
    const value = run.groups!.value!
    if (value !== '' && !/^[>|]/.test(value)) {
      commands.push(value)
      continue
    }
    const indent = run.groups!.indent!.length
    const block: string[] = []
    while (index + 1 < lines.length) {
      const next = lines[index + 1]!
      const nextIndent = next.match(/^\s*/)?.[0].length ?? 0
      if (next.trim() !== '' && nextIndent <= indent) break
      block.push(next)
      index += 1
    }
    commands.push(block.join('\n'))
  }
  return commands
}

type PlaywrightContainerImage = {
  reference: string
  version: string
  suffix: string
}

function playwrightContainerImage(job: string): PlaywrightContainerImage | undefined {
  const lines = job.split('\n')
  const container = lines.findIndex((line) => /^ {4}container:\s*$/.test(line))
  if (container < 0) return undefined
  for (let index = container + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (line.trim() !== '' && indent <= 4) break
    const image =
      /^ {6}image:\s*(mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(-[^\s]+)?)\s*$/.exec(line)
    if (image) return { reference: image[1]!, version: image[2]!, suffix: image[3] ?? '' }
  }
  return undefined
}

function checkPlaywrightBunInstall(job: string, jobName: string): void {
  if (job.includes('oven-sh/setup-bun')) {
    throw new Error(
      `.github/workflows/ci.yml job ${jobName} must not use oven-sh/setup-bun because the Playwright image has no unzip; replace it with an Install Bun step that runs ${playwrightBunInstallCommand}`,
    )
  }
  if (!workflowRunCommands(job).includes(playwrightBunInstallCommand)) {
    throw new Error(
      `.github/workflows/ci.yml job ${jobName} must install Bun from .bun-version; add an Install Bun step that runs ${playwrightBunInstallCommand}`,
    )
  }
}

function checkPlaywrightWorkspaceTrust(job: string, jobName: string): void {
  if (!workflowRunCommands(job).includes(playwrightTrustWorkspaceCommand)) {
    throw new Error(
      `.github/workflows/ci.yml job ${jobName} must trust the workspace because the Playwright container runs as root over a workspace owned by the runner user, so git refuses it, and the repository tooling reads git with global config disabled, so the trust must be system-wide; add a Trust the workspace step that runs ${playwrightTrustWorkspaceCommand}`,
    )
  }
}

function aggregateNeeds(source: string): string[] {
  const job = workflowJob(source, 'ci')
  const inline = job.match(/^ {4}needs:\s*\[([^\]]*)\]\s*$/m)
  if (inline)
    return inline[1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  const lines = job.split('\n')
  const start = lines.findIndex((line) => line === '    needs:')
  if (start < 0) return []
  return lines
    .slice(start + 1)
    .flatMap((line) => line.match(/^ {6}-\s+([a-z][a-z0-9-]*)\s*$/)?.[1] ?? [])
}

/** The shell rendering of a declared suite's argv, for the workflow `run:` line. */
export function suiteRunLine(argv: readonly string[]): string {
  return argv
    .map((argument) => (/^[\w./=@-]+$/.test(argument) ? argument : `'${argument}'`))
    .join(' ')
}

/** Pins each declared CI-only suite job: its Python, and the exact command it runs. */
function checkCiOnlySuiteJobs(source: string): void {
  for (const suite of CI_ONLY_SUITES) {
    const job = workflowJob(source, suite.job)
    if (!job.includes('uses: actions/setup-python@v6') || !job.includes("python-version: '3.12'"))
      throw new Error(`the ${suite.job} job must use Python 3.12`)
    const command = `run: ${suiteRunLine(suite.argv)}`
    if (!job.includes(command))
      throw new Error(`the ${suite.job} job must run its declared suite: ${command}`)
  }
}

/** Pins Playwright container versions and forbids runtime browser installation. */
function checkPlaywrightJobs(source: string, jobNames: readonly string[]): void {
  const playwrightPin = playwrightDependencyPin()
  for (const jobName of playwrightBrowserJobs) {
    const job = workflowJob(source, jobName)
    if (!playwrightContainerImage(job)) {
      throw new Error(
        `.github/workflows/ci.yml job ${jobName} must run in the pinned Playwright image; add container: image: mcr.microsoft.com/playwright:v${playwrightPin}-noble`,
      )
    }
    checkPlaywrightWorkspaceTrust(job, jobName)
    checkPlaywrightBunInstall(job, jobName)
  }
  for (const jobName of jobNames) {
    const job = workflowJob(source, jobName)
    const image = playwrightContainerImage(job)
    if (image && image.version !== playwrightPin) {
      throw new Error(
        `.github/workflows/ci.yml job ${jobName} uses Playwright image ${image.reference}; set the image tag to v${playwrightPin}${image.suffix}`,
      )
    }
    for (const command of workflowRunCommands(job)) {
      if (/\bplaywright\s+install\b/.test(command)) {
        throw new Error(
          `.github/workflows/ci.yml job ${jobName} runs "playwright install"; remove that command and run the job in the pinned Playwright image instead`,
        )
      }
    }
  }
}

export function expectedWorkflowJobNames(): string[] {
  return [
    'secrets',
    'static',
    ...CHECK_LEGS.flatMap((leg) => (leg.ciJob === null ? [] : [leg.ciJob])),
    ...CI_ONLY_JOBS,
    'root',
    'ci',
  ].sort()
}

export function checkCiWorkflow(source: string): void {
  const actual = workflowJobNames(source).sort()
  const expected = expectedWorkflowJobNames()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `CI jobs do not match check plan: expected ${expected.join(', ')}; got ${actual.join(', ')}`,
    )
  }
  const actualNeeds = aggregateNeeds(source).sort()
  const expectedNeeds = expectedWorkflowJobNames().filter((name) => name !== 'ci')
  if (JSON.stringify(actualNeeds) !== JSON.stringify(expectedNeeds)) {
    const missing = expectedNeeds.filter((name) => !actualNeeds.includes(name))
    const unknown = actualNeeds.filter((name) => !expectedNeeds.includes(name))
    throw new Error(
      `CI aggregate needs do not match check plan: missing ${missing.join(', ') || 'none'}; unknown ${unknown.join(', ') || 'none'}`,
    )
  }
  checkPlaywrightJobs(source, actual)
  if (!workflowJob(source, 'hub-ui-stories').includes('bun run --cwd hub/ui storybook:test'))
    throw new Error('hub-ui-stories job must run the hub-ui story-test script')
  if (!workflowJob(source, 'hub-ui-stories').includes('bun run --cwd hub/views storybook:test'))
    throw new Error('hub-ui-stories job must run the hub-views story-test script')
  const hooks = workflowJob(source, 'orchestrator-hooks')
  if (!hooks.includes('uses: actions/setup-python@v6') || !hooks.includes("python-version: '3.12'"))
    throw new Error('orchestrator-hooks job must use Python 3.12')
  if (!hooks.includes('run: $SUITE_COMMAND --only=orchestrator/hooks'))
    throw new Error('orchestrator-hooks job must run its check-plan leg')
  checkCiOnlySuiteJobs(source)
  const postgres = workflowJob(source, 'postgres')
  if (!postgres.includes('image: postgres:18-alpine'))
    throw new Error('postgres job must use Postgres 18')
  if (!postgres.includes('uses: oven-sh/setup-bun@v2')) throw new Error('postgres job must use Bun')
  if (!postgres.includes('run: bun install --silent'))
    throw new Error('postgres job must install the workspace')
  if (!postgres.includes(postgresServiceContainer))
    throw new Error('postgres job must pass its service container to the real-Postgres suite')
  if (!postgres.includes('run: bun run --cwd orchestrator test:postgres --without-live-import'))
    throw new Error('postgres job must run the real-Postgres suite without the live import proof')
}

/** Keeps release creation inside the release publisher; check-bun-versions owns the Bun declaration. */
export function checkReleaseWorkflow(source: string): void {
  for (const command of workflowRunCommands(workflowJob(source, 'release'))) {
    const directRelease = /\bgh\s+release\s+(upload|create)\b/.exec(command)
    if (directRelease) {
      throw new Error(
        `release job steps must publish every asset through "bun run release:publish", which writes and verifies SHA256SUMS; found "gh release ${directRelease[1]}"`,
      )
    }
  }
}

if (import.meta.main) {
  checkCiWorkflow(readFileSync(`${root}.github/workflows/ci.yml`, 'utf8'))
  console.log('CI workflow covers every check-plan leg and the root test batch')
  checkReleaseWorkflow(readFileSync(`${root}.github/workflows/release.yml`, 'utf8'))
  console.log('release workflow check passed')
}
