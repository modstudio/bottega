import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minutesOfDay } from '../orchestrator/src/spare/spare-decisions.ts'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { exitUnchecked } from '../shared/check-execution.ts'
import {
  FIX_DEFECT_BACKSTOP_SECONDS,
  LAUNCH_AGENT_PLACEHOLDERS,
  MONITOR_BACKSTOP_SECONDS,
} from '../shared/launch-agent-render.ts'
import { readMachineValue } from '../shared/machine-config.ts'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  STATE_HOME_ENV,
} from '../shared/state-directory.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const templateDirectories = [
  { directory: 'ops/launchd', concern: join(repositoryRoot, 'ops'), installer: 'ops/install.sh' },
  {
    directory: 'hub/launchd',
    concern: join(repositoryRoot, 'hub'),
    installer: 'hub/bin/install-launchd.sh',
  },
] as const

const stateHomeExemptions = new Map<string, string>([
  [
    'ops/launchd/com.user.brew-auto-upgrade.plist.template',
    'runs Homebrew only; never opens a platform store',
  ],
  [
    'ops/launchd/com.user.docker-prune.plist.template',
    'runs Docker only; never opens a platform store',
  ],
  [
    'ops/launchd/com.user.local-model-tunnel.plist.template',
    'runs ssh only; never opens a platform store',
  ],
  [
    'ops/launchd/com.user.record-tunnel.plist.template',
    'runs flyctl only; never opens a platform store',
  ],
])

/** Every `__NAME__` placeholder the text mentions, in first-seen order. */
export function templatePlaceholders(text: string): string[] {
  return [...new Set(text.match(/__[A-Z0-9_]+__/g) ?? [])]
}

function rendererInvocations(script: string): string[][] {
  return script
    .replaceAll(/\\\r?\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) =>
      (line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((token) =>
        /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token,
      ),
    )
    .filter(
      (tokens) =>
        tokens[0] === 'bun' &&
        tokens[1] === '--no-env-file' &&
        tokens[2]?.endsWith('shared/launch-agent-render.ts'),
    )
}

/** The placeholders an installer's substitution rules cover. */
export function installerPlaceholders(script: string): Set<string> {
  const invocations = rendererInvocations(script)
  const rendererRules = new Set<string>()
  for (const tokens of invocations) {
    for (let index = 5; index + 1 < tokens.length; index += 2) {
      const placeholder = tokens[index]!
      if (/^__[A-Z0-9_]+__$/.test(placeholder)) rendererRules.add(placeholder)
    }
  }
  return rendererRules
}

/** Explicit installer pairs plus defaults supplied by the renderer CLI itself. */
export function installerRenderRules(script: string): Set<string> {
  const rules = installerPlaceholders(script)
  if (rendererInvocations(script).length > 0) {
    rules.add('__MONITOR_BACKSTOP_SECONDS__')
    rules.add('__FIX_DEFECT_BACKSTOP_SECONDS__')
  }
  return rules
}

/**
 * Template placeholders the installer that renders them has no rule for. A
 * placeholder with no rule is installed literally - inside an `<integer>` that
 * launchd then refuses - so the gate must fail on it instead of substituting a
 * value of its own and passing a plist the installer could never produce.
 */
export function missingInstallRules(input: {
  templateName: string
  templateText: string
  installerName: string
  installRules: ReadonlySet<string>
}): string[] {
  return templatePlaceholders(input.templateText)
    .filter((placeholder) => !input.installRules.has(placeholder))
    .map(
      (placeholder) =>
        `${input.templateName}: placeholder ${placeholder} has no rule in ${input.installerName}`,
    )
}

/** The hour and minute an `HH:MM` clock value names, or null when malformed. */
export function clockParts(value: string): { hour: number; minute: number } | null {
  try {
    const minutes = minutesOfDay(value)
    return { hour: Math.floor(minutes / 60), minute: minutes % 60 }
  } catch {
    return null
  }
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function calendarIntervalsHaveIntegerFields(value: unknown): boolean {
  const intervals = Array.isArray(value) ? value : [value]
  return (
    intervals.length > 0 &&
    intervals.every(
      (interval) =>
        objectValue(interval) &&
        Object.values(interval).every((part) => typeof part === 'number' && Number.isInteger(part)),
    )
  )
}

/** Type errors in launchd fields whose plist shape controls scheduling. */
export function launchdFieldTypeViolations(plist: unknown, name: string): string[] {
  if (!objectValue(plist)) return [`${name}: rendered plist root must be a dictionary`]
  const errors: string[] = []
  for (const key of ['QueueDirectories', 'WatchPaths'] as const) {
    if (!(key in plist)) continue
    const value = plist[key]
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      errors.push(`${name}: ${key} must be an array of strings`)
    }
  }
  for (const key of ['StartInterval', 'ThrottleInterval'] as const) {
    if (!(key in plist)) continue
    if (typeof plist[key] !== 'number' || !Number.isInteger(plist[key])) {
      errors.push(`${name}: ${key} must be an integer`)
    }
  }
  if ('StartCalendarInterval' in plist) {
    if (!calendarIntervalsHaveIntegerFields(plist.StartCalendarInterval)) {
      errors.push(
        `${name}: StartCalendarInterval must be a dictionary or array of dictionaries with integer fields`,
      )
    }
  }
  return errors
}

/**
 * The value each placeholder is rendered with for the lint. Anything launchd
 * reads as a number comes from the same source the installer reads, so the lint
 * render and the install render cannot disagree.
 */
type LaunchAgentPlaceholder = (typeof LAUNCH_AGENT_PLACEHOLDERS)[number]

function lintValues(concern: string): Record<LaunchAgentPlaceholder, string | null> {
  const spare = clockParts(readMachineValue('spare.start_time'))
  const stateHome = `/tmp/${PLATFORM_SLUG}-state`
  return {
    __INSTALL_ROOT__: repositoryRoot,
    __BOTTEGA_BIN__: join(repositoryRoot, 'bin', PLATFORM_SLUG),
    __CONCERN__: concern,
    __HOME__: '/tmp',
    __STATE_HOME_ENV__: `${PLATFORM_SLUG.toUpperCase()}_STATE_HOME`,
    __STATE_HOME__: stateHome,
    __RECORD_SYNC_QUEUE__: recordSyncQueueDirectory({ [STATE_HOME_ENV]: stateHome }),
    __RECORD_SYNC_MARKER__: RECORD_SYNC_PENDING_MARKER,
    __MONITOR_BACKSTOP_SECONDS__: String(MONITOR_BACKSTOP_SECONDS),
    __FIX_DEFECT_BACKSTOP_SECONDS__: String(FIX_DEFECT_BACKSTOP_SECONDS),
    __MODEL_HOST__: 'example',
    __TUNNEL_LOCAL_PORT__: '8010',
    __TUNNEL_REMOTE_PORT__: '8000',
    __FLYCTL__: '/usr/bin/true',
    __SPARE_START_HOUR__: spare ? String(spare.hour) : null,
    __SPARE_START_MINUTE__: spare ? String(spare.minute) : null,
    __RECORD_TUNNEL_APP__: 'example-record',
    __RECORD_TUNNEL_LOCAL_PORT__: '15432',
    __RECORD_TUNNEL_REMOTE_PORT__: '5432',
    __HUB_PORT__: '7778',
    __HUB_HOSTED_URL__: 'https://hub.example',
  }
}

type TemplateFact = { concern: string; installer: string; name: string }

/** Every checked-in launchd template, with the installer that renders it. */
function discoverTemplates(): TemplateFact[] {
  return templateDirectories
    .flatMap(({ directory, concern, installer }) =>
      readdirSync(join(repositoryRoot, directory))
        .filter((name) => name.endsWith('.plist.template'))
        .map((name) => ({ concern, installer, name: join(directory, name) })),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Lint one rendered plist and check that its first program argument exists. */
function checkRenderedPlist(input: { name: string; path: string; plutil: string }): string[] {
  const errors: string[] = []
  const lint = startBoundedSync([input.plutil, '-lint', input.path], { budget: 'process-table' })
  if (lint.exitCode !== 0) {
    errors.push(`${input.name}: launchd template failed plutil -lint`)
    const detail = lint.stdout.toString() + lint.stderr.toString()
    if (detail.trim()) errors.push(detail.trim())
    return errors
  }
  const jsonResult = startBoundedSync([input.plutil, '-convert', 'json', '-o', '-', input.path], {
    budget: 'process-table',
  })
  if (jsonResult.exitCode !== 0) {
    errors.push(`${input.name}: rendered launchd template could not be parsed as JSON`)
  } else {
    try {
      errors.push(
        ...launchdFieldTypeViolations(JSON.parse(jsonResult.stdout.toString()), input.name),
      )
    } catch {
      errors.push(`${input.name}: rendered launchd template produced invalid JSON`)
    }
  }
  const programResult = startBoundedSync(
    [input.plutil, '-extract', 'ProgramArguments.0', 'raw', input.path],
    { budget: 'process-table' },
  )
  const program = programResult.stdout.toString().trim()
  if (programResult.exitCode !== 0 || !program) {
    errors.push(`${input.name}: launchd template has no first program argument`)
  } else if (!existsSync(program)) {
    errors.push(`${input.name}: launchd program does not exist: ${program}`)
  }
  return errors
}

/**
 * Check one template against the installer that renders it: the state-home
 * entry, a substitution rule for every placeholder, and the lint of the render
 * that installer's rules actually produce.
 */
function checkTemplate(input: {
  fact: TemplateFact
  plutil: string
  renderedDirectory: string
}): string[] {
  const { concern, installer, name } = input.fact
  const errors: string[] = []
  const template = readFileSync(join(repositoryRoot, name), 'utf8')
  if (!stateHomeExemptions.has(name) && !template.includes('<key>__STATE_HOME_ENV__</key>')) {
    errors.push(`${name}: launchd template is missing the state-home environment entry`)
  }
  errors.push(
    ...missingInstallRules({
      templateName: name,
      templateText: template,
      installerName: installer,
      installRules: installerRenderRules(readFileSync(join(repositoryRoot, installer), 'utf8')),
    }),
  )
  let rendered = template
  const values = lintValues(concern)
  for (const placeholder of templatePlaceholders(template)) {
    const value = LAUNCH_AGENT_PLACEHOLDERS.includes(placeholder as LaunchAgentPlaceholder)
      ? values[placeholder as LaunchAgentPlaceholder]
      : null
    if (value === null) {
      errors.push(`${name}: no lint value for placeholder ${placeholder}`)
      continue
    }
    rendered = rendered.replaceAll(placeholder, value)
  }
  const path = join(input.renderedDirectory, name.replaceAll('/', '-').replace(/\.template$/, ''))
  writeFileSync(path, rendered)
  errors.push(...checkRenderedPlist({ name, path, plutil: input.plutil }))
  return errors
}

/** Every state-home exemption must state a reason and name a real template. */
function checkStateHomeExemptions(names: readonly string[]): string[] {
  const errors: string[] = []
  for (const [name, reason] of stateHomeExemptions) {
    if (!reason.trim()) {
      errors.push(`${name}: state-home exemption must state a reason`)
    } else if (!names.includes(name)) {
      errors.push(`${name}: state-home exemption names no launchd template`)
    }
  }
  return errors
}

function main(): void {
  const plutil = Bun.which('plutil')
  if (!plutil) {
    exitUnchecked('plutil is not available')
  }

  const templates = discoverTemplates()
  const renderedDirectory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-launchd-lint-`))
  let errors: string[] = []
  try {
    for (const fact of templates) {
      errors = errors.concat(checkTemplate({ fact, plutil, renderedDirectory }))
    }
    errors = errors.concat(checkStateHomeExemptions(templates.map((template) => template.name)))
  } finally {
    rmSync(renderedDirectory, { recursive: true, force: true })
  }

  for (const error of errors) console.error(error)
  if (errors.length > 0) process.exit(1)
}

if (import.meta.main) main()
