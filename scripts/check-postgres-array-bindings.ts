#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['hub', 'orchestrator', 'shared']
const DIRECT_ARRAY_CAST = /\}::[a-z_]+\[\]/g
const SQL_TEMPLATE_LITERAL =
  /[A-Za-z_$][\w.$]*\s*\\?`\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|SET|SAVEPOINT|ROLLBACK|RELEASE)\b[\s\S]*?`/gi
const DIRECT_JSON_CAST = /^\s*::(?:text\s*::\s*)?jsonb?\b/
const JSON_SERIALIZER = /^(?:JSON\.stringify|canonicalJson)\(/
const JSON_TEXT_EXEMPTIONS = new Map([
  [
    'orchestrator/src/record/record-port-catalogue.ts',
    new Map([
      ['JSON.stringify(source.commits)', 'port_ref_source.commits is a text column'],
      ['JSON.stringify(source.paths)', 'port_ref_source.paths is a text column'],
    ]),
  ],
])
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/
const violations: string[] = []

function interpolations(template: string) {
  const found: { expression: string; index: number; end: number }[] = []
  let searchFrom = 0
  while (searchFrom < template.length) {
    const index = template.indexOf('${', searchFrom)
    if (index === -1) break
    let depth = 1
    let cursor = index + 2
    for (; cursor < template.length && depth > 0; cursor++) {
      if (template[cursor] === '{') depth++
      else if (template[cursor] === '}') depth--
    }
    if (depth > 0) break
    found.push({ expression: template.slice(index + 2, cursor - 1), index, end: cursor })
    searchFrom = cursor
  }
  return found
}

export function postgresBindingViolations(source: string, file: string): string[] {
  const found: string[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('#')
    )
      continue
    DIRECT_ARRAY_CAST.lastIndex = 0
    if (DIRECT_ARRAY_CAST.test(line)) found.push(`${file}:${index + 1}:array`)
  }
  SQL_TEMPLATE_LITERAL.lastIndex = 0
  for (const template of source.matchAll(SQL_TEMPLATE_LITERAL)) {
    for (const interpolation of interpolations(template[0])) {
      const offset = template.index + interpolation.index
      const line = source.slice(0, offset).split('\n').length
      const prefix = lines[line - 1]?.trimStart() ?? ''
      if (
        prefix.startsWith('//') ||
        prefix.startsWith('*') ||
        prefix.startsWith('/*') ||
        prefix.startsWith('#')
      )
        continue
      const expression = interpolation.expression.trim()
      const afterInterpolation = template[0].slice(interpolation.end)
      const exempt = JSON_TEXT_EXEMPTIONS.get(file)?.has(expression) ?? false
      if (
        (!exempt && JSON_SERIALIZER.test(expression)) ||
        DIRECT_JSON_CAST.test(afterInterpolation)
      )
        found.push(`${file}:${line}:jsonb`)
    }
  }
  return found
}

for (const sourceRoot of SOURCE_ROOTS) {
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, sourceRoot) })) {
    if (relative.includes('node_modules/') || TEST_FILE.test(relative)) continue
    const file = join(sourceRoot, relative)
    violations.push(...postgresBindingViolations(readFileSync(join(ROOT, file), 'utf8'), file))
  }
}

for (const violation of violations) {
  const [file, line, kind] = violation.split(':')
  console.error(
    kind === 'jsonb'
      ? `${file}:${line}: refused a direct interpolation cast to json/jsonb; use bindJsonb(sql, value)`
      : `${file}:${line}: refused an interpolation immediately followed by '::<type>[]' on one line; use sql.array(values, type), or tx.array(values, type) inside a transaction`,
  )
}
if (violations.length) process.exit(1)

console.log('check-postgres-array-bindings: ok')
