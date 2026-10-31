import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { type ChangeViewMode, openChangeView } from '../../../shared/change-view.ts'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { type Finding, findingLine, ratchetDecision } from '../../../shared/ratchet.ts'
import { WORKER_GATE_BASE_ENV } from '../gate/gate-decision.ts'
import { projectAt } from '../project/projects.ts'
import { biomeFindings } from './biome-adapter.ts'
import { type MeasurePattern, phpcsFindings, phpstanFindings } from './php-report-adapters.ts'
import { commandForSide, type SideFile, sideFiles, supportPlacements } from './ratchet-plan.ts'
import { ratchetVisibility } from './ratchet-visibility.ts'

type Reporter = Pick<Console, 'error' | 'log'>
type RatchetOptions = {
  cwd: string
  format: string
  staged: boolean
  base?: string
  support: string[]
  command?: string[]
  headReport?: string
  baseReport?: string
  reportRoot?: string
  measures?: MeasurePattern[]
}

const LINTER_TIMEOUT_MS = 120_000

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, '--no-optional-locks', ...args], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim() || 'no error output'}`,
    )
  }
  return result.stdout.toString().trim()
}

function checkoutRoot(cwd: string) {
  return git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
}

function comparisonBase(root: string, options: RatchetOptions): string {
  const workerGateBase = process.env[WORKER_GATE_BASE_ENV]?.trim()
  if (workerGateBase) return workerGateBase
  if (options.staged) return 'HEAD'
  if (options.base) return options.base
  const project = projectAt(root)
  const landing = project?.settings.trunk?.trim()
  if (!project || !landing) {
    throw new Error('could not resolve a registered project landing branch; pass --base <ref>')
  }
  return git(root, ['merge-base', 'HEAD', `origin/${landing}`])
}

function validatedSupport(root: string, paths: string[]) {
  for (const path of paths) {
    if (!path || isAbsolute(path) || relative('.', path).startsWith('..')) {
      throw new Error(
        `--support must name a relative path inside the checkout: ${path || '(empty)'}`,
      )
    }
    if (!existsSync(resolve(root, path))) {
      throw new Error(`--support path does not exist: ${path}`)
    }
  }
}

export function materializeSupport(root: string, mirror: string, paths: string[]) {
  for (const placement of supportPlacements(root, mirror, paths)) {
    mkdirSync(dirname(placement.destination), { recursive: true })
    const stat = lstatSync(placement.source)
    if (stat.isDirectory()) symlinkSync(placement.source, placement.destination, 'dir')
    else copyFileSync(placement.source, placement.destination)
  }
}

function materializeFiles(root: string, files: SideFile[], support: string[]) {
  const mirror = mkdtempSync(join(tmpdir(), 'orch-ratchet-'))
  try {
    for (const file of files) {
      const destination = resolve(mirror, file.path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, file.content.text)
    }
    materializeSupport(root, mirror, support)
    return mirror
  } catch (error) {
    rmSync(mirror, { recursive: true, force: true })
    throw error
  }
}

function adapter(format: string): (text: string) => Finding[] {
  if (format === 'biome') return biomeFindings
  throw new Error(`unknown ratchet format ${JSON.stringify(format)}; available: biome`)
}

function reportAdapter(format: string) {
  if (format === 'phpcs') return phpcsFindings
  if (format === 'phpstan') return phpstanFindings
  throw new Error(`unknown report format ${JSON.stringify(format)}; available: phpcs, phpstan`)
}

function reportFindings(
  path: string,
  format: string,
  reportRoot: string,
  measures: MeasurePattern[],
) {
  const parse = reportAdapter(format)
  return parse(readFileSync(path, 'utf8'), { reportRoot, measures })
}

function runSide(
  root: string,
  cwd: string,
  command: string[],
  files: string[],
  parse: (text: string) => Finding[],
) {
  if (!files.length) return { ok: true as const, findings: [] }
  const argv = commandForSide(command, files, root)
  if (!argv.length) return { ok: false as const, reason: 'the linter command is empty' }
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: LINTER_TIMEOUT_MS,
    })
  } catch (error) {
    return {
      ok: false as const,
      reason: `${argv[0]} could not run: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (result.exitedDueToTimeout) {
    return {
      ok: false as const,
      reason: `${argv[0]} timed out after ${LINTER_TIMEOUT_MS}ms`,
    }
  }
  let findings: Finding[]
  try {
    findings = parse(result.stdout?.toString() ?? '')
  } catch (error) {
    const detail = result.stderr?.toString().trim() ?? ''
    return {
      ok: false as const,
      reason: `could not parse ${argv[0]} output: ${error instanceof Error ? error.message : String(error)}${detail ? `; ${detail}` : ''}`,
    }
  }
  return { ok: true as const, findings }
}

function refusalReason(finding: ReturnType<typeof ratchetDecision>[number]) {
  if (finding.reason === 'grew') return `grew from ${finding.previousMeasure}`
  if (finding.reason === 'added-line') return 'finding is on an added line'
  if (finding.reason === 'new-measured') return 'new measured finding'
  return 'finding count increased'
}

type RatchetView = ReturnType<typeof openChangeView>

export function runReportsMode(
  options: RatchetOptions,
  root: string,
  view: Pick<RatchetView, 'facts'>,
  headReport: string,
  baseReport: string,
  reporter: Reporter,
) {
  let headFindings: Finding[]
  try {
    headFindings = reportFindings(
      headReport,
      options.format,
      options.reportRoot ?? root,
      options.measures ?? [],
    )
  } catch (error) {
    throw new Error(
      `head report ${headReport} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  reporter.log(`ratchet remaining: ${headFindings.length} findings in the head report`)
  let baseFindings: Finding[] = []
  const unanalysedBase = new Set<string>()
  try {
    baseFindings = reportFindings(
      baseReport,
      options.format,
      options.reportRoot ?? root,
      options.measures ?? [],
    )
  } catch (error) {
    reporter.error(
      `ratchet base report ${baseReport} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    for (const finding of headFindings) unanalysedBase.add(finding.file)
  }
  return reportDecision(baseFindings, headFindings, view.facts, unanalysedBase, reporter)
}

function runCommandMode(
  options: RatchetOptions,
  root: string,
  view: RatchetView,
  command: string[],
  parse: (text: string) => Finding[],
  reporter: Reporter,
) {
  const lintEntries = view.entries.filter(
    (entry) =>
      !options.support.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
  )
  const baseFiles = sideFiles(lintEntries, 'base', view.baseContent)
  const headFiles = sideFiles(lintEntries, 'head', view.headContent)
  let baseMirror: string | undefined
  let headMirror: string | undefined
  try {
    baseMirror = materializeFiles(root, baseFiles, options.support)
    const baseResult = runSide(
      root,
      baseMirror,
      command,
      baseFiles.map(({ path }) => path),
      parse,
    )
    if (options.staged) headMirror = materializeFiles(root, headFiles, options.support)
    const headRoot = headMirror ?? root
    const headResult = runSide(
      root,
      headRoot,
      command,
      headFiles.map(({ path }) => path),
      parse,
    )
    if (!headResult.ok) throw new Error(`current side failed: ${headResult.reason}`)
    reporter.log(`ratchet remaining: ${headResult.findings.length} findings on changed files only`)
    const unanalysedBase = new Set<string>()
    const baseFindings = baseResult.ok ? baseResult.findings : []
    if (!baseResult.ok) {
      reporter.error(`ratchet base side failed: ${baseResult.reason}`)
      for (const file of headFiles) unanalysedBase.add(file.path)
    }
    return reportDecision(baseFindings, headResult.findings, view.facts, unanalysedBase, reporter)
  } finally {
    if (baseMirror) rmSync(baseMirror, { recursive: true, force: true })
    if (headMirror) rmSync(headMirror, { recursive: true, force: true })
  }
}

export async function runRatchet(options: RatchetOptions, reporter: Reporter = console) {
  const root = checkoutRoot(options.cwd)
  const headReport = options.headReport
  const baseReport = options.baseReport
  const reportsMode = headReport && baseReport
  const command = options.command ?? []
  if (!reportsMode) {
    validatedSupport(root, options.support)
    if (!command.includes('{files}')) throw new Error('linter command must contain {files}')
  }
  const base = comparisonBase(root, options)
  const mode: ChangeViewMode = options.staged ? 'staged' : 'worktree'
  const view = openChangeView({ cwd: root, base, mode })
  const comparisonView =
    mode === 'staged' ? openChangeView({ cwd: root, base, mode: 'worktree' }) : view
  const visibility = ratchetVisibility({
    comparisonPaths: comparisonView.entries.map(({ path }) => path),
    visiblePaths: view.entries.map(({ path }) => path),
  })
  if (!visibility.visible) {
    reporter.error(visibility.reason)
    return false
  }
  if (reportsMode) {
    return runReportsMode(options, root, view, headReport, baseReport, reporter)
  }
  return runCommandMode(options, root, view, command, adapter(options.format), reporter)
}

function reportDecision(
  base: Finding[],
  head: Finding[],
  change: Parameters<typeof ratchetDecision>[0]['change'],
  unanalysedBase: Set<string>,
  reporter: Reporter,
) {
  const refused = ratchetDecision({ base, head, change, unanalysedBase })
  for (const finding of refused) {
    reporter.error(`${findingLine(finding)}; ${refusalReason(finding)}`)
  }
  return refused.length === 0
}
