// concern: storage lifecycle check
/** Refuses lifecycle declarations that do not match the three store schemas. */

import { isAbsolute, resolve } from 'node:path'
import type { LifecycleStore, TableLifecycle } from '../shared/storage-lifecycle.ts'

type SchemaTable = { name: string; columns: readonly string[] }
type Tables = Readonly<Record<LifecycleStore, readonly SchemaTable[]>>
type ResolveSymbol = (path: string, symbol: string) => boolean | Promise<boolean>

function declarationShapeRefusals(address: string, declaration: TableLifecycle): string[] {
  const findings: string[] = []
  if (!declaration.keep.trim()) findings.push(`${address}: lifecycle keep rule is empty`)
  if (declaration.remover === null && !declaration.slice)
    findings.push(`${address}: null lifecycle remover must name its owing slice`)
  if (
    declaration.remover === 'kept' &&
    declaration.class !== 'record' &&
    declaration.class !== 'machine'
  )
    findings.push(
      `${address}: kept lifecycle marker is valid only for record or bounded machine rows`,
    )
  return findings
}

async function removerRefusal(
  address: string,
  declaration: TableLifecycle,
  resolveSymbol: ResolveSymbol,
): Promise<string | null> {
  if (!declaration.remover || declaration.remover === 'kept') return null
  const split = declaration.remover.lastIndexOf('#')
  const path = declaration.remover.slice(0, split)
  const symbol = declaration.remover.slice(split + 1)
  return split >= 1 && symbol && (await resolveSymbol(path, symbol))
    ? null
    : `${address}: lifecycle remover ${declaration.remover} does not resolve`
}

export async function storageLifecycleRefusals(
  tables: Tables,
  declarations: readonly TableLifecycle[],
  resolveSymbol: ResolveSymbol,
): Promise<string[]> {
  const findings: string[] = []
  const schema = new Set(
    Object.entries(tables).flatMap(([store, values]) =>
      values.map((table) => `${store}.${table.name}`),
    ),
  )
  const columns = new Map<string, ReadonlySet<string>>(
    Object.entries(tables).flatMap(([store, values]) =>
      values.map((table) => [`${store}.${table.name}`, new Set(table.columns)] as const),
    ),
  )
  const declared = new Set<string>()
  for (const declaration of declarations) {
    const address = `${declaration.store}.${declaration.table}`
    if (declared.has(address)) findings.push(`${address}: lifecycle declaration is duplicated`)
    declared.add(address)
    if (!schema.has(address)) findings.push(`${address}: lifecycle declaration is stale`)
    findings.push(...declarationShapeRefusals(address, declaration))
    for (const payload of declaration.payloadColumns ?? []) {
      if (!columns.get(address)?.has(payload.column))
        findings.push(`${address}.${payload.column}: lifecycle payload column does not exist`)
    }
    const unresolved = await removerRefusal(address, declaration, resolveSymbol)
    if (unresolved) findings.push(unresolved)
  }
  for (const address of schema) {
    if (!declared.has(address)) findings.push(`${address}: lifecycle declaration is missing`)
  }
  return findings.sort()
}

export async function repositoryLifecycleSymbol(path: string, symbol: string): Promise<boolean> {
  if (isAbsolute(path)) return false
  try {
    const module = (await import(resolve(import.meta.dir, '..', path))) as Record<string, unknown>
    return symbol in module
  } catch {
    return false
  }
}
