import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'

const MASKED_TABLES = [
  'hub_note',
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'context_item',
  'question',
  'workflow_step_text',
  'workflow_text_copy',
  'workflow_version',
  'workflow_event',
  'step_catalogue_version',
  'step_catalogue_event',
  'doc',
  'doc_revision',
] as const

export type HostedWriterFinding = { file: string; table: string }

export function hostedWriterFindings(file: string, source: string): HostedWriterFinding[] {
  return MASKED_TABLES.flatMap((table) => {
    const writes = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE)\\s+${table}\\b`, 'i').test(source)
    if (!writes) return []
    const masked = new RegExp(`maskHostedTableWrite\\([\\s\\S]{0,160}['"]${table}['"]`).test(source)
    return masked ? [] : [{ file, table }]
  })
}

export async function currentHostedWriterFindings(root = resolve(import.meta.dir, '..')) {
  const findings: HostedWriterFinding[] = []
  for (const pattern of ['hub/src/**/*.ts', 'orchestrator/src/record/**/*.ts']) {
    for await (const file of new Glob(pattern).scan({ cwd: root })) {
      if (file.endsWith('.test.ts') || file.includes('/migrations')) continue
      const source = readFileSync(resolve(root, file), 'utf8')
      if (!source.includes('tx`')) continue
      findings.push(...hostedWriterFindings(file, source))
    }
  }
  return findings
}

if (import.meta.main) {
  const started = performance.now()
  const findings = await currentHostedWriterFindings()
  for (const finding of findings)
    console.error(`${finding.file}: hosted ${finding.table} write bypasses maskHostedTableWrite`)
  if (findings.length) process.exitCode = 1
  console.log(`hosted secret writer call sites: ${(performance.now() - started).toFixed(1)} ms`)
}
