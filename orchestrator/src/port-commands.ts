// concern: port-commands
/** Knows port ledger command semantics and presentation. Must not know runs, routing, transports, the CLI, or worktrees. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DB_PATH } from './db.ts'
import {
  addDoctrineRule,
  addPair,
  addSkip,
  baselineForPair,
  ledgerRef,
  listDoctrineRules,
  listLedgerRefs,
  listSkips,
  pairByProjects,
  removeLedgerRef,
  resolveLedgerRef,
  retireDoctrineRule,
  setBaseline,
  setLedgerRef,
} from './porting.ts'
import {
  applyImport,
  ImportRefusalError,
  planImport,
  projectsForDryRun,
  sourceCoverage,
} from './porting-import.ts'
import { projectByName, projects } from './projects.ts'

type PortFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type PortPresentation = {
  log(...values: unknown[]): void
  writeStdout(value: string): Promise<void>
  exitCode(code: number): void
}

export async function portCommand(
  group: string | undefined,
  action: string | undefined,
  argv: string[],
  flags: PortFlags,
  presentation: PortPresentation,
): Promise<void> {
  const { has, flag } = flags
  const { log, writeStdout, exitCode } = presentation
  const namedProject = (name: string) => {
    const project = projectByName(name)
    if (!project)
      throw new Error(
        `unknown project "${name}". Registered: ${projects()
          .map((row) => row.name)
          .join(', ')}`,
      )
    return project
  }
  const namedPair = (sourceName: string, targetName: string, create = false) => {
    const source = namedProject(sourceName)
    const target = namedProject(targetName)
    if (source.id === target.id)
      throw new Error('a port source and target must be different projects')
    const pair =
      pairByProjects(source.id, target.id) ?? (create ? addPair(source.id, target.id) : null)
    return { pair, source, target }
  }
  const output = (value: unknown, line: string) => log(has('json') ? JSON.stringify(value) : line)

  if (group === 'import') {
    const dir = argv[2]
    if (!dir) throw new Error('orch port import <dir> [--dry-run] [--replace] [--json]')
    const names = {
      doctrine: 'doctrine.md',
      differences: 'differences.md',
      backports: 'backports.md',
      refs: 'refs.json',
      state: 'state.json',
      projects: 'projects.md',
    } as const
    const files = {} as Record<keyof typeof names, string>
    const ioRefusals: { kind: 'refusal'; what: string; where: string; why: string }[] = []
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a directory')
      readdirSync(dir)
    } catch (error) {
      ioRefusals.push({ kind: 'refusal', what: 'source directory', where: dir, why: String(error) })
    }
    for (const [key, name] of Object.entries(names) as [keyof typeof names, string][]) {
      const path = join(dir, name)
      try {
        files[key] = readFileSync(path, 'utf8')
      } catch (error) {
        files[key] = ''
        ioRefusals.push({
          kind: 'refusal',
          what: `source file "${name}"`,
          where: path,
          why: String(error),
        })
      }
    }
    let plan: ReturnType<typeof planImport>
    if (ioRefusals.length) {
      plan = {
        pairs: [],
        baselines: [],
        skips: [],
        refs: [],
        doctrine: [],
        docs: [],
        refusals: ioRefusals,
        exclusions: [],
      }
    } else {
      let registered: ReturnType<typeof projects>
      try {
        registered = has('dry-run') ? projectsForDryRun(DB_PATH) : projects()
      } catch (error) {
        ioRefusals.push({
          kind: 'refusal',
          what: 'project register',
          where: DB_PATH,
          why: String(error),
        })
        registered = []
      }
      plan = ioRefusals.length
        ? {
            pairs: [],
            baselines: [],
            skips: [],
            refs: [],
            doctrine: [],
            docs: [],
            refusals: ioRefusals,
            exclusions: [],
          }
        : planImport(files, registered)
    }
    const visiblePlan = () => {
      const uncoveredSpans = sourceCoverage(plan, files)
      return {
        ...plan,
        doctrine: plan.doctrine.map((row) => ({ ...row, bodyLength: row.body.length })),
        docs: plan.docs.map((row) => ({ ...row, bodyLength: row.body.length })),
        uncoveredSpans,
      }
    }
    const printPlan = async () => {
      const visible = visiblePlan()
      const uncoveredSpans = visible.uncoveredSpans
      if (has('json')) {
        await writeStdout(`${JSON.stringify(visible, null, 2)}\n`)
        return
      }
      log(`pairs (${plan.pairs.length})`)
      for (const row of plan.pairs)
        log(`  ${row.source} -> ${row.target}  ids ${row.sourceId}->${row.targetId}`)
      log(`baselines (${plan.baselines.length})`)
      for (const row of plan.baselines)
        log(`  ${row.pairKey}  ${row.sourceCommit ?? 'null'}  ${row.scannedAt ?? 'null'}`)
      log(`skips (${plan.skips.length})`)
      for (const row of plan.skips) log(`  ${row.pairKey}  ${row.candidate}  reason=${row.reason}`)
      log(`refs (${plan.refs.length})`)
      for (const row of plan.refs) {
        log(`  ${row.taskKey}  note=${JSON.stringify(row.note)}`)
        for (const source of row.sources) {
          log(
            `    source_project_id=${source.source_project_id} commits=${JSON.stringify(source.commits)} paths=${JSON.stringify(source.paths)} note=${JSON.stringify(source.note)}`,
          )
        }
      }
      log(`doctrine (${plan.doctrine.length})`)
      for (const row of plan.doctrine)
        log(`  ${row.number}  ${row.title}  body length=${row.body.length}`)
      log(`docs (${plan.docs.length})`)
      for (const row of plan.docs) {
        log(
          `  ${row.scope}/${row.subject ?? '_'}/${row.slug}  ${row.title}  body length=${row.body.length}`,
        )
      }
      log(`refusals (${plan.refusals.length})`)
      for (const refusal of plan.refusals) {
        log(`  ${refusal.what} / ${refusal.where} / ${refusal.why}`)
      }
      log(`exclusions (${plan.exclusions.length})`)
      for (const exclusion of plan.exclusions) {
        log(`  ${exclusion.what} / ${exclusion.where} / ${exclusion.why}`)
        if (exclusion.value !== undefined) log(`    original value: ${exclusion.value}`)
      }
      log(`uncovered spans (${uncoveredSpans.length})`)
      for (const span of uncoveredSpans) {
        log(`  ${span.file} offset ${span.offset} / ${JSON.stringify(span.text)}`)
      }
    }
    if (has('dry-run')) {
      await printPlan()
      if (plan.refusals.length) exitCode(1)
      return
    }
    try {
      applyImport(plan, { replace: has('replace'), sourceLabel: dir })
    } catch (error) {
      if (!(error instanceof ImportRefusalError)) throw error
      plan.refusals.push(...error.refusals.filter((refusal) => !plan.refusals.includes(refusal)))
      await printPlan()
      exitCode(1)
      return
    }
    if (has('json')) log(JSON.stringify(visiblePlan(), null, 2))
    else
      log(
        `imported ${plan.pairs.length} pairs, ${plan.refs.length} refs, ${plan.doctrine.length} doctrine rules, and ${plan.docs.length} docs`,
      )
    return
  }

  if (group === 'baseline' && action === 'show') {
    const sourceName = argv[3]
    const targetName = argv[4]
    if (!sourceName || !targetName)
      throw new Error('orch port baseline show <source> <target> [--json]')
    const { pair } = namedPair(sourceName, targetName)
    if (!pair) {
      output(null, `no port pair from "${sourceName}" to "${targetName}"`)
      return
    }
    const value = { pair, baseline: baselineForPair(pair.id) }
    output(
      value,
      value.baseline?.source_commit
        ? `${sourceName} -> ${targetName}  ${value.baseline.source_commit}  ${value.baseline.scanned_at}`
        : `${sourceName} -> ${targetName}  no baseline`,
    )
    return
  }

  if (group === 'baseline' && action === 'set') {
    const sourceName = argv[3]
    const targetName = argv[4]
    const commit = has('clear') ? null : argv[5]
    if (!sourceName || !targetName || (!has('clear') && !commit)) {
      throw new Error('orch port baseline set <source> <target> <commit> [--json] | --clear')
    }
    const { pair } = namedPair(sourceName, targetName, true)
    const baseline = setBaseline(pair!.id, commit)
    output(
      { pair, baseline },
      commit
        ? `set ${sourceName} -> ${targetName} baseline to ${commit}`
        : `cleared ${sourceName} -> ${targetName} baseline`,
    )
    return
  }

  if (group === 'skip' && action === 'list') {
    const sourceName = argv[3]
    const targetName = argv[4]
    if (!sourceName || !targetName)
      throw new Error('orch port skip list <source> <target> [--json]')
    const { pair } = namedPair(sourceName, targetName)
    const rows = pair ? listSkips(pair.id) : []
    if (has('json')) {
      log(JSON.stringify(rows))
      return
    }
    for (const row of rows) log(`${row.candidate}  ${row.reason}  ${row.skipped_at}`)
    return
  }

  if (group === 'skip' && action === 'add') {
    const sourceName = argv[3]
    const targetName = argv[4]
    const candidate = argv[5]
    const reason = flag('reason')
    if (!sourceName || !targetName || !candidate || reason === undefined) {
      throw new Error('orch port skip add <source> <target> <candidate> --reason TEXT [--json]')
    }
    const { pair } = namedPair(sourceName, targetName)
    if (!pair)
      throw new Error(
        `no port pair from "${sourceName}" to "${targetName}"; set its baseline first`,
      )
    const row = addSkip(pair.id, candidate, reason)
    output(row, `skipped ${candidate}: ${reason}`)
    return
  }

  if (group === 'ref' && action === 'list') {
    const rows = listLedgerRefs(has('all'))
    if (has('json')) {
      log(JSON.stringify(rows))
      return
    }
    for (const row of rows) {
      log(
        `${row.task_key}  ${row.sources.length} source(s)  ${row.resolved_at ?? 'unresolved'}  ${row.note}`,
      )
    }
    return
  }

  if (group === 'ref' && action === 'show') {
    const taskKey = argv[3]
    if (!taskKey) throw new Error('orch port ref show <task-key> [--json]')
    const ref = ledgerRef(taskKey)
    if (!ref) throw new Error(`no port ledger ref for task "${taskKey}"`)
    if (has('json')) {
      log(JSON.stringify(ref))
      return
    }
    log(`${ref.task_key}  ${ref.resolved_at ?? 'unresolved'}\n${ref.note}`)
    for (const source of ref.sources) {
      const project = projects().find((candidate) => candidate.id === source.source_project_id)
      if (!project)
        throw new Error(
          `ledger ref ${taskKey} names unregistered project id ${source.source_project_id}`,
        )
      log(
        `  ${project.name}  commits=${source.commits.join(',')}  paths=${source.paths.join(',')}  ${source.note}`,
      )
    }
    return
  }

  if (group === 'ref' && action === 'set') {
    const taskKey = argv[3]
    const sourceJson = flag('sources')
    const note = flag('note')
    if (!taskKey || sourceJson === undefined || note === undefined) {
      throw new Error('orch port ref set <task-key> --sources JSON --note TEXT [--json]')
    }
    let raw: unknown
    try {
      raw = JSON.parse(sourceJson)
    } catch (error) {
      throw new Error(`--sources must be JSON: ${error}`)
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('--sources must be a non-empty JSON array')
    }
    const sources = raw.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`--sources[${index}] must be an object`)
      }
      const source = value as Record<string, unknown>
      if (
        typeof source.project !== 'string' ||
        !Array.isArray(source.commits) ||
        !source.commits.every((item) => typeof item === 'string') ||
        !Array.isArray(source.paths) ||
        !source.paths.every((item) => typeof item === 'string') ||
        typeof source.note !== 'string'
      ) {
        throw new Error(
          `--sources[${index}] needs project, string-array commits, string-array paths, and note`,
        )
      }
      return {
        source_project_id: namedProject(source.project).id,
        commits: source.commits as string[],
        paths: source.paths as string[],
        note: source.note,
      }
    })
    const ref = setLedgerRef({ taskKey, note, sources })
    output(ref, `recorded provenance for ${taskKey} from ${sources.length} source project(s)`)
    return
  }

  if (group === 'ref' && action === 'resolve') {
    const taskKey = argv[3]
    if (!taskKey) throw new Error('orch port ref resolve <task-key> [--json]')
    const ref = resolveLedgerRef(taskKey)
    if (!ref) throw new Error(`no port ledger ref for task "${taskKey}"`)
    output(ref, `resolved ${taskKey} at ${ref.resolved_at}`)
    return
  }

  if (group === 'ref' && action === 'delete-error') {
    const taskKey = argv[3]
    if (!taskKey) throw new Error('orch port ref delete-error <task-key> [--json]')
    const removed = removeLedgerRef(taskKey)
    output(
      { removed },
      removed
        ? `permanently deleted erroneous ledger ref ${taskKey}`
        : `no port ledger ref for task "${taskKey}"`,
    )
    return
  }

  if (group === 'doctrine' && action === 'list') {
    const rows = listDoctrineRules(has('all'))
    if (has('json')) {
      log(JSON.stringify(rows))
      return
    }
    for (const row of rows) {
      log(
        `${String(row.number).padStart(3)}  ${row.retired_at ? `retired ${row.retired_at}` : 'active'}  ${row.title}`,
      )
    }
    return
  }

  if (group === 'doctrine' && action === 'add') {
    const number = Number(argv[3])
    const title = flag('title')
    if (!Number.isInteger(number) || number <= 0 || title === undefined) {
      throw new Error(
        'orch port doctrine add <number> --title TEXT (--file F | body on stdin) [--json]',
      )
    }
    const body = flag('file')
      ? readFileSync(flag('file')!, 'utf8')
      : !process.stdin.isTTY
        ? await Bun.stdin.text()
        : (() => {
            throw new Error('no body: pass --file F or pipe text on stdin')
          })()
    const rule = addDoctrineRule(number, title, body)
    output(rule, `added doctrine ${number}: ${title}`)
    return
  }

  if (group === 'doctrine' && action === 'retire') {
    const number = Number(argv[3])
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error('orch port doctrine retire <number> [--json]')
    }
    const retired = retireDoctrineRule(number)
    output({ retired }, retired ? `retired doctrine ${number}` : `no active doctrine ${number}`)
    return
  }

  const portVerbs: Record<string, string> = {
    baseline: 'show | set',
    skip: 'list | add',
    ref: 'list | show | set | resolve | delete-error',
    doctrine: 'list | add | retire',
  }
  if (group && portVerbs[group]) {
    throw new Error(
      `unknown: orch port ${group}${action ? ` ${action}` : ''}. Try ${portVerbs[group]}`,
    )
  }
  throw new Error('unknown: orch port. Try import | baseline | skip | ref | doctrine')
}
