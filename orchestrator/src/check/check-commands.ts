import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitToplevel } from '../../../shared/git.ts'
import { flagValue } from '../cli/args.ts'
import { type Project, projectAt, projectByName } from '../project/projects.ts'
import {
  formatAttributionFinding,
  type SourcedAttributionFinding,
  sourcedAttributionFindings,
} from './check-attribution.ts'
import { formatSpellingFinding, spellingFindings, typosVersionRefusal } from './check-spelling.ts'

type Presentation = {
  log(value: string): void
  setExitCode(code: number): void
  stdinText(): Promise<string>
  stdinIsTTY(): boolean | undefined
  cwd(): string
}

function selectedProject(argv: string[], cwd: string): Project {
  const name = flagValue(argv, 'project')
  const project = name ? projectByName(name) : projectAt(cwd)
  if (!project) {
    throw new Error(
      name
        ? `no project "${name}"`
        : `no registered project contains ${cwd}; pass --project <name>`,
    )
  }
  return project
}

function checkout(project: Project, explicitProject: boolean, cwd: string): string {
  if (explicitProject) return project.path
  const root = gitToplevel(cwd)
  if (!root) throw new Error(`refusing ${cwd}: not a git checkout`)
  return root
}

function typosVersion(binary: string): string | null {
  const result = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : ''
}

function spellingCommand(argv: string[], presentation: Presentation): void {
  const cwd = presentation.cwd()
  const project = selectedProject(argv, cwd)
  const root = checkout(project, flagValue(argv, 'project') !== undefined, cwd)
  const binary = Bun.which('typos')
  const refusal = typosVersionRefusal(binary ? typosVersion(binary) : null, process.platform)
  if (refusal) throw new Error(refusal)

  const hasConfiguration = ['typos.toml', '_typos.toml'].some((name) =>
    existsSync(resolve(root, name)),
  )
  const command = [binary!, '--format', 'json']
  if (!hasConfiguration) command.push('--locale', 'en-us')
  if (argv.includes('--fix')) command.push('--write-changes')
  command.push('.')
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  let findings: ReturnType<typeof spellingFindings>
  try {
    findings = spellingFindings(result.stdout.toString())
  } catch (error) {
    throw new Error(
      `could not parse typos output: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  for (const finding of findings) presentation.log(formatSpellingFinding(finding))
  if (findings.length) {
    presentation.setExitCode(1)
    return
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`typos failed with exit ${result.exitCode}${detail ? `: ${detail}` : ''}`)
  }
}

function spawnText(argv: string[], cwd: string, label: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`${label} failed with exit ${result.exitCode}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.toString()
}

function rangeFindings(range: string, root: string): SourcedAttributionFinding[] {
  const output = spawnText(
    ['git', 'log', '-z', '--format=%H%x00%B', range],
    root,
    `git log ${range}`,
  )
  const fields = output.split('\0')
  const findings: SourcedAttributionFinding[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index]!.trim()
    if (sha) findings.push(...sourcedAttributionFindings(sha, fields[index + 1]!))
  }
  return findings
}

type AttributionMode =
  | { kind: 'message'; file: string }
  | { kind: 'pr'; value: string }
  | { kind: 'stdin' }
  | { kind: 'range'; value?: string }

function attributionMode(argv: string[], stdinIsTTY: boolean | undefined): AttributionMode {
  const message = flagValue(argv, 'message')
  const pr = flagValue(argv, 'pr')
  const rangeIndex = argv.indexOf('--range')
  const selected =
    Number(message !== undefined) + Number(pr !== undefined) + Number(rangeIndex >= 0)
  if (selected > 1) throw new Error('choose only one of --message, --range, or --pr')
  if (message !== undefined) return { kind: 'message', file: message }
  if (pr !== undefined) return { kind: 'pr', value: pr }
  if (rangeIndex < 0 && stdinIsTTY === false) return { kind: 'stdin' }
  const value =
    rangeIndex >= 0 && argv[rangeIndex + 1] && !argv[rangeIndex + 1]!.startsWith('--')
      ? argv[rangeIndex + 1]
      : undefined
  return { kind: 'range', value }
}

async function attributionCommand(argv: string[], presentation: Presentation): Promise<void> {
  const cwd = presentation.cwd()
  const project = selectedProject(argv, cwd)
  const root = checkout(project, flagValue(argv, 'project') !== undefined, cwd)
  const mode = attributionMode(argv, presentation.stdinIsTTY())

  let findings: SourcedAttributionFinding[]
  if (mode.kind === 'message') {
    findings = sourcedAttributionFindings('message', readFileSync(resolve(cwd, mode.file), 'utf8'))
  } else if (mode.kind === 'pr') {
    const output = spawnText(
      ['gh', 'pr', 'view', mode.value, '--json', 'title,body'],
      root,
      `gh pr view ${mode.value}`,
    )
    const value = JSON.parse(output) as { title?: unknown; body?: unknown }
    if (typeof value.title !== 'string' || typeof value.body !== 'string') {
      throw new Error('gh pr view returned malformed title/body JSON')
    }
    findings = sourcedAttributionFindings('pr', `${value.title}\n${value.body}`)
  } else if (mode.kind === 'stdin') {
    findings = sourcedAttributionFindings('stdin', await presentation.stdinText())
  } else {
    const trunk = project.settings.trunk?.trim()
    const range = mode.value ?? (trunk ? `origin/${trunk}..HEAD` : null)
    if (!range) {
      throw new Error(
        `project ${project.name} has no trunk for the default range; pass --range <rev-range>`,
      )
    }
    findings = rangeFindings(range, root)
  }

  for (const finding of findings) presentation.log(formatAttributionFinding(finding))
  if (findings.length) presentation.setExitCode(1)
}

export async function checkCommand(argv: string[], presentation: Presentation): Promise<void> {
  const kind = argv[1]
  if (kind === 'spelling') spellingCommand(argv, presentation)
  else if (kind === 'attribution') await attributionCommand(argv, presentation)
  else throw new Error('unknown: orch check. Try spelling | attribution')
}
