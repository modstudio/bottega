#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

const startedAt = performance.now()
const root = new URL('..', import.meta.url)
const subjects = ['shared/record/migrations/**/*', 'scripts/**/*']
const refused = [
  { kind: 'replication-role', source: ['session', '_replication_role'].join('') },
  { kind: 'trigger-disable', source: ['disable', '\\s+', 'trigger'].join('') },
  {
    kind: 'table-disable',
    source: ['alter', '\\s+', 'table', '[^;]{0,240}?', 'disable'].join(''),
  },
] as const
const historicalRlsLift = [
  'shared/record/migrations/20261015180415_dev_1214_project_move_constraint_rls/migration.sql',
  'table-disable',
  ['ALTER TABLE "project" DIS', 'ABLE'].join(''),
].join(':')

const findings: string[] = []
for (const subject of subjects) {
  const glob = new Bun.Glob(subject)
  for await (const path of glob.scan({ cwd: root.pathname, onlyFiles: true })) {
    const contents = await readFile(new URL(path, root), 'utf8').catch(() => null)
    if (contents === null) continue
    for (const pattern of refused) {
      for (const match of contents.matchAll(new RegExp(pattern.source, 'gi'))) {
        const key = [path, pattern.kind, match[0]].join(':')
        if (key !== historicalRlsLift) findings.push(`${path}: ${pattern.kind}`)
      }
    }
  }
}

if (findings.length) {
  console.error(`record trigger bypass refused in: ${findings.sort().join(', ')}`)
  process.exit(1)
}
console.log(
  `record trigger bypass: migrations and scripts checked in ${(performance.now() - startedAt).toFixed(1)}ms`,
)
