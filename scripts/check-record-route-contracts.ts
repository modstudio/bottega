import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'
import { idleRecordApiDeps, idleSubjectDeps } from '../orchestrator/test/fixtures/record-api.ts'
import { recordApiTestApp } from '../orchestrator/test/fixtures/record-api-app.ts'
import type { Finding } from '../shared/ratchet.ts'
import { ratchetDecision } from '../shared/ratchet.ts'

export type RecordRouteBaseline = { route: string; reason: `untested` | `unsupported:${string}` }

export function undeclaredRecordRoutes(
  routes: readonly string[],
  contracts: ReadonlySet<string>,
  baseline: readonly RecordRouteBaseline[],
): string[] {
  const accepted = new Set([...contracts, ...baseline.map((entry) => entry.route)])
  return [...new Set(routes)].filter((route) => !accepted.has(route)).sort()
}

function routeFindings(routes: readonly string[]): Finding[] {
  return routes.map((route) => ({
    file: 'orchestrator/src/record/record-api.ts',
    line: 0,
    rule: 'record-route-contract',
    message: route,
  }))
}

function appRoutes(): string[] {
  const app = recordApiTestApp(null, { ...idleSubjectDeps(), ...idleRecordApiDeps() })
  return [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort()
}

async function declaredRoutes(root: string): Promise<Set<string>> {
  const declared = new Set<string>()
  for await (const path of new Glob('orchestrator/src/**/*-contract.test.ts').scan({ cwd: root })) {
    const source = readFileSync(resolve(root, path), 'utf8')
    const literal = source.match(/const contractRoutes\s*=\s*\[([\s\S]*?)\]\s*as const/)
    if (!literal) continue
    for (const route of literal[1]!.matchAll(/['"]([^'"]+)['"]/g)) declared.add(route[1]!)
  }
  return declared
}

async function checkRecordRouteContracts(root = resolve(import.meta.dir, '..')) {
  const baselinePath = resolve(root, 'scripts/quality/record-route-contracts.json')
  const routes = appRoutes()
  const contracts = await declaredRoutes(root)
  if (process.argv.includes('--update')) {
    const entries = routes
      .filter((route) => !contracts.has(route))
      .map((route) => ({ route, reason: 'untested' as const }))
    writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`)
    return []
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as RecordRouteBaseline[]
  const undeclared = undeclaredRecordRoutes(routes, contracts, baseline)
  return ratchetDecision({
    base: routeFindings(baseline.map((entry) => entry.route)),
    head: routeFindings(undeclared),
    change: { renames: new Map(), addedLines: new Map() },
  })
}

if (import.meta.main) {
  const started = performance.now()
  const refused = await checkRecordRouteContracts()
  if (refused.length) {
    for (const finding of refused)
      console.error(`record route lacks a contract: ${finding.message}`)
    process.exitCode = 1
  }
  console.log(`record route contracts: ${(performance.now() - started).toFixed(1)} ms`)
}
