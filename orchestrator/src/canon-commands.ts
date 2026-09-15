// concern: canon-commands
/** Knows canon command semantics over canon and evals. Must not know runs, routing, transports, the CLI, or worktrees. */
import {
  allInjectChecks,
  allNumericLiterals,
  compilePack,
  diffPack,
  findingsForPack,
} from './canon.ts'
import { canonEvalsReport, runCanonEvals } from './evals.ts'

type CanonFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type CanonPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  cwd(): string
}

export async function canonCommand(
  argv: string[],
  flags: CanonFlags,
  presentation: CanonPresentation,
): Promise<void> {
  const { has, flag } = flags
  const { log, exitCode } = presentation
  const sub = argv[1]
  const cwd = flag('cwd') ?? presentation.cwd()
  const jobName = flag('job') ?? 'understand'
  if (sub === 'eval') {
    const rows = await runCanonEvals({
      slug: flag('slug'),
      agent: flag('agent'),
      force: has('force'),
    })
    if (has('json')) log(JSON.stringify(rows))
    else {
      for (const row of rows) {
        const verdict = row.skipped ? 'skip' : row.pass ? 'pass' : 'fail'
        log(`${row.slug}  ${row.agent}  ${verdict}  ${row.why}  ${row.canonSha}`)
      }
    }
    if (rows.some((row) => !row.skipped && row.pass === false)) exitCode(1)
    return
  }
  if (sub === 'evals') {
    const report = canonEvalsReport()
    if (has('json')) log(JSON.stringify(report))
    else {
      for (const row of report.latest) {
        const good = report.last_known_good.find(
          (item) => item.slug === row.slug && item.agent === row.agent,
        )
        log(
          `${row.slug}  ${row.agent}  ${row.pass ? 'pass' : 'fail'}  ${row.why}  ${row.canon_sha}` +
            (good ? `  last-pass ${good.canon_sha}` : '  last-pass none'),
        )
      }
    }
    return
  }
  if (sub === 'check') {
    const pack = compilePack({ job: jobName, cwd })
    const rows = has('all') ? allInjectChecks() : findingsForPack(pack)
    const findings = rows.flatMap((row) =>
      row.findings.map((finding) => ({ doc: row.doc, ...finding })),
    )
    const numericReport = allNumericLiterals(cwd)
    const numericLiterals = numericReport.numericLiterals.filter(
      (hit) => hit.classification === 'RESTATED',
    )
    const result = {
      pack: {
        job: pack.job,
        project: pack.project,
        bytes: pack.bytes,
        budgetBytes: pack.budgetBytes,
        sha256: pack.sha256,
      },
      docs: rows,
      findings,
      numericLiterals,
      canonFiles: numericReport.canonFiles,
    }
    if (has('json')) log(JSON.stringify(result))
    else {
      log(`canon: ${pack.bytes}/${pack.budgetBytes} bytes`)
      for (const row of rows.filter((row) => row.findings.length)) {
        log(
          `${row.doc.scope}/${row.doc.subject ?? '_'}/${row.doc.slug} revision ${row.doc.revisionId}`,
        )
        for (const finding of row.findings) log(`  ${finding.kind}: ${finding.message}`)
      }
      log(
        `canon files: read ${numericReport.canonFiles.read.join(', ') || 'none'}` +
          `; missing ${numericReport.canonFiles.missing.join(', ') || 'none'}`,
      )
      log('numeric literals')
      for (const hit of numericLiterals) {
        log(`  ${hit.source}  ${hit.numeral}  ${hit.sentence}`)
      }
    }
    if (findings.length) exitCode(1)
    return
  }
  if (sub === 'diff') {
    const result = diffPack({ job: jobName, cwd })
    if (has('json')) log(JSON.stringify(result))
    else {
      log(
        `canon ${result.job}/${result.project ?? '_'}: ${result.bytesDelta >= 0 ? '+' : ''}${result.bytesDelta} bytes`,
      )
      for (const doc of result.added)
        log(`  added ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`)
      for (const doc of result.removed)
        log(`  removed ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`)
      for (const doc of result.changed)
        log(`  changed ${doc.slug} revision ${doc.fromRevision} -> ${doc.toRevision}`)
    }
    return
  }
  throw new Error('unknown: orch canon. Try check | diff | eval | evals')
}
