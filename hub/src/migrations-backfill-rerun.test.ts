import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitMigrationSource } from '../../shared/migration-source.ts'
import { MIGRATIONS_FOLDER, migrationJournal, stripSqlComments } from './migrations.ts'

function sqlStatements(source: string): string[] {
  const statements: string[] = []
  let start = 0
  let inString = false
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "'") {
      if (inString && source[index + 1] === "'") index++
      else inString = !inString
    } else if (!inString && source[index] === ';') {
      statements.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  const final = source.slice(start).trim()
  if (final) statements.push(final)
  return statements.filter(Boolean)
}

function topLevelKeyword(source: string, keyword: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index <= source.length - keyword.length; index++) {
    const char = source[index]!
    if (char === "'") {
      if (inString && source[index + 1] === "'") index++
      else inString = !inString
      continue
    }
    if (inString) continue
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (
      depth === 0 &&
      source.slice(index, index + keyword.length).toLowerCase() === keyword &&
      !/[a-z0-9_]/i.test(source[index - 1] ?? '') &&
      !/[a-z0-9_]/i.test(source[index + keyword.length] ?? '')
    )
      return index
  }
  return -1
}

function topLevelParts(source: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let inString = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char === "'") {
      if (inString && source[index + 1] === "'") index++
      else inString = !inString
    } else if (!inString && char === '(') depth++
    else if (!inString && char === ')') depth--
    else if (!inString && depth === 0 && char === separator) {
      parts.push(source.slice(start, index))
      start = index + 1
    }
  }
  parts.push(source.slice(start))
  return parts
}

function topLevelCharacter(source: string, target: string): number {
  let depth = 0
  let inString = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char === "'") {
      if (inString && source[index + 1] === "'") index++
      else inString = !inString
    } else if (!inString && char === '(') depth++
    else if (!inString && char === ')') depth--
    else if (!inString && depth === 0 && char === target) return index
  }
  return -1
}

function setColumns(statement: string, setAt: number, whereAt: number): string[] {
  return topLevelParts(statement.slice(setAt + 3, whereAt), ',').map((assignment) => {
    const equalsAt = topLevelCharacter(assignment, '=')
    const left = (equalsAt === -1 ? assignment : assignment.slice(0, equalsAt)).trim()
    return left
      .replaceAll(/^[`"[]|[`"\]]$/g, '')
      .split('.')
      .at(-1)!
  })
}

function nullRestricted(columns: string[], where: string): boolean {
  return columns.every((column) =>
    new RegExp(`\\b${column.replaceAll(/[^a-z0-9_]/gi, '\\$&')}\\s+is\\s+null\\b`, 'i').test(where),
  )
}

function markerRestricted(tag: string, where: string, block: string): boolean {
  const match = where.match(
    /\bnot\s+exists\s*\(\s*select\s+1\s+from\s+setting\s+where\s+key\s*=\s*'([^']+)'\s*\)/i,
  )
  const key = match?.[1]
  if (!key || !new RegExp(`^migration\\.${tag.replaceAll('.', '\\.')}\\.[a-z0-9_-]+$`).test(key))
    return false
  const quotedKey = key.replaceAll("'", "''")
  return new RegExp(
    `\\binsert\\s+or\\s+ignore\\s+into\\s+setting\\s*\\(\\s*key\\s*,\\s*value\\s*\\)\\s*values\\s*\\(\\s*'${quotedKey}'`,
    'i',
  ).test(block)
}

function unsafeUpdate(tag: string, block: string, statement: string, index: number): string | null {
  if (!/^\s*update\b/i.test(statement)) return null
  const setAt = topLevelKeyword(statement, 'set', 0)
  const whereAt = topLevelKeyword(statement, 'where', setAt + 3)
  const columns = setAt === -1 || whereAt === -1 ? [] : setColumns(statement, setAt, whereAt)
  const where = whereAt === -1 ? '' : statement.slice(whereAt + 5)
  const safe =
    columns.length > 0 && (nullRestricted(columns, where) || markerRestricted(tag, where, block))
  return safe ? null : `${tag} statement ${index + 1}`
}

function unsafeBackfillUpdates(): string[] {
  return migrationJournal().flatMap((entry) => {
    const source = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8')
    const block = stripSqlComments(splitMigrationSource(source).backfill)
    return sqlStatements(block)
      .map((statement, index) => unsafeUpdate(entry.tag, block, statement, index))
      .filter((finding): finding is string => finding !== null)
  })
}

test('every migration BACKFILL update changes no row when its block runs again', () => {
  expect(unsafeBackfillUpdates()).toEqual([])
})
