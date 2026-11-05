#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

const startedAt = performance.now()
const root = new URL('..', import.meta.url)
const subjects = ['shared/record/migrations/**/*', 'scripts/**/*']
const refused = [
  { kind: 'replication-role', source: ['session', '_replication_role'].join('') },
  { kind: 'trigger-disable', source: ['disable', '\\s+', 'trigger'].join('') },
] as const

const findings: string[] = []
for (const subject of subjects) {
  const glob = new Bun.Glob(subject)
  for await (const path of glob.scan({ cwd: root.pathname, onlyFiles: true })) {
    const contents = await readFile(new URL(path, root), 'utf8').catch(() => null)
    if (contents === null) continue
    for (const pattern of refused) {
      if (new RegExp(pattern.source, 'i').test(contents)) findings.push(`${path}: ${pattern.kind}`)
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
