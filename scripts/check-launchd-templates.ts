import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minutesOfDay } from '../orchestrator/src/spare/spare-decisions.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { readMachineValue } from '../shared/machine-config.ts'

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

/** The placeholders an installer's substitution rules cover. */
export function installerPlaceholders(script: string): Set<string> {
  const names = [...script.matchAll(/s#(__[A-Z0-9_]+__)#/g)].map((match) => match[1]!)
  return new Set(names)
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

/**
 * The value each placeholder is rendered with for the lint. Anything launchd
 * reads as a number comes from the same source the installer reads, so the lint
 * render and the install render cannot disagree.
 */
function renderValue(placeholder: string, concern: string): string | null {
  const spare = clockParts(readMachineValue('spare.start_time'))
  switch (placeholder) {
    case '__INSTALL_ROOT__':
      return repositoryRoot
    case '__CONCERN__':
      return concern
    case '__HOME__':
      return '/tmp'
    case '__STATE_HOME_ENV__':
      return `${PLATFORM_SLUG.toUpperCase()}_STATE_HOME`
    case '__STATE_HOME__':
      return `/tmp/${PLATFORM_SLUG}-state`
    case '__HUB_HOSTED_URL__':
      return 'https://hub.example'
    case '__HUB_PORT__':
      return '7778'
    case '__MONITOR_BACKSTOP_SECONDS__':
      return '14400'
    case '__FIX_DEFECT_BACKSTOP_SECONDS__':
      return '43200'
    case '__MODEL_HOST__':
      return 'example'
    case '__TUNNEL_LOCAL_PORT__':
      return '8010'
    case '__TUNNEL_REMOTE_PORT__':
      return '8000'
    case '__FLYCTL__':
      return '/usr/bin/true'
    case '__RECORD_TUNNEL_APP__':
      return 'example-record'
    case '__RECORD_TUNNEL_LOCAL_PORT__':
      return '15432'
    case '__RECORD_TUNNEL_REMOTE_PORT__':
      return '5432'
    case '__SPARE_START_HOUR__':
      return spare ? String(spare.hour) : null
    case '__SPARE_START_MINUTE__':
      return spare ? String(spare.minute) : null
    default:
      return null
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
  const lint = Bun.spawnSync([input.plutil, '-lint', input.path], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (lint.exitCode !== 0) {
    errors.push(`${input.name}: launchd template failed plutil -lint`)
    const detail = lint.stdout.toString() + lint.stderr.toString()
    if (detail.trim()) errors.push(detail.trim())
    return errors
  }
  const programResult = Bun.spawnSync(
    [input.plutil, '-extract', 'ProgramArguments.0', 'raw', input.path],
    { stdout: 'pipe', stderr: 'pipe' },
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
      installRules: installerPlaceholders(readFileSync(join(repositoryRoot, installer), 'utf8')),
    }),
  )
  let rendered = template
  for (const placeholder of templatePlaceholders(template)) {
    const value = renderValue(placeholder, concern)
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
    console.log('check-launchd-templates: skipped; plutil is not available')
    process.exit(0)
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
