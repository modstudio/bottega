#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const STATE_FILE = `${ROOT}/scripts/quality/test-init-sites.json`
const STATE_LABEL = 'scripts/quality/test-init-sites.json'

function testFiles(): string[] {
  const files: string[] = []
  const visit = (directory: string, recursive: boolean) => {
    for (const entry of readdirSync(directory)) {
      const absolute = resolve(directory, entry)
      if (statSync(absolute).isDirectory()) {
        if (recursive && !['node_modules', 'dist'].includes(entry)) visit(absolute, true)
      } else if (/\.test\.tsx?$/.test(entry)) {
        files.push(relative(ROOT, absolute))
      }
    }
  }
  visit(resolve(ROOT, 'orchestrator/src'), false)
  visit(resolve(ROOT, 'hub'), true)
  visit(resolve(ROOT, 'shared'), true)
  return files.sort()
}

function initSiteCount(source: string): number {
  const directRanges = [...source.matchAll(/\['git', 'init'[^\]\n]*\]/g)]
    .map((match) => [match.index, match.index + match[0].length] as const)
  const helperSites = [...source.matchAll(/'init', '-b'/g)]
    .filter((match) => !directRanges.some(([start, end]) => start <= match.index && match.index < end))
  return directRanges.length + helperSites.length
}

function ordered(state: Record<string, number>) {
  return Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)))
}

const allowed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, number>
const measured = new Map(testFiles().map((path) => [
  path, initSiteCount(readFileSync(resolve(ROOT, path), 'utf8')),
]))
const next = { ...allowed }
const violations: string[] = []
const tightenings: string[] = []

for (const [path, count] of measured) {
  const ceiling = allowed[path] ?? 0
  if (count > ceiling) violations.push(`${path}: ${count} git init sites, permitted ${ceiling}`)
  if (allowed[path] !== undefined && count < ceiling) {
    if (count === 0) delete next[path]
    else next[path] = count
    tightenings.push(`${STATE_LABEL}: ${path} tightened ${ceiling} -> ${count}`)
  }
}
for (const path of Object.keys(allowed)) {
  if (measured.has(path) || existsSync(resolve(ROOT, path))) continue
  delete next[path]
  tightenings.push(`${STATE_LABEL}: ${path} tightened ${allowed[path]} -> removed`)
}

if (JSON.stringify(ordered(next)) !== JSON.stringify(ordered(allowed))) {
  writeFileSync(STATE_FILE, `${JSON.stringify(ordered(next), null, 2)}\n`)
}
for (const message of tightenings) console.error(message)
for (const message of violations) console.error(message)
if (tightenings.length) console.error(`baseline tightened; commit ${STATE_LABEL} and re-run`)
if (violations.length || tightenings.length) process.exit(1)
console.log(`check-test-spawns: ok (${measured.size} unit test files, ${Object.keys(allowed).length} allowed init sites)`)
