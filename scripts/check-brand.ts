#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
/**
 * The brand name is written in ONE place, and this is what makes that true.
 *
 * a sibling project's own guard is the precedent and its reasoning is the whole argument:
 * a brand module nobody is obliged to use collects leaked literals until the
 * rename it existed to make cheap is a hunt through twenty files. The module is
 * only load-bearing if something fails when the literal appears elsewhere.
 *
 * PROSE IS EXEMPT, CODE IS NOT — and a COMMENT IS PROSE. Markdown is where the
 * name is supposed to be said, and so is the comment above a function
 * explaining what bottega does with the thing it returns. A check that forbade
 * that would make the code worse to satisfy a rule about literals: it caught
 * nine explanatory comments on its first real run and not one actual leak.
 *
 * What the rule is actually for is a literal used as DATA — a hardcoded
 * `'bottega'` in a list of projects, a path built from the name, a title
 * string. Those are what make a rename a hunt. So comment lines are skipped and
 * code lines are not.
 *
 * The frozen exceptions are named in `shared/brand.ts` and honoured here: `orch`
 * and `hub` are per-concern binaries rather than the platform's name, and are
 * wired into PATH, launchd, and a hook that runs in every session on this
 * machine. Renaming one of those is a migration with a rollout.
 */
import { Glob } from 'bun'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../shared/brand.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** Where the name is allowed to be a literal, and why. */
const ALLOWED = new Set([
  // The module whose entire job is to hold it.
  'shared/brand.ts',
  // This file, which has to mention it in order to look for it.
  'scripts/check-brand.ts',
  // The package manifest: read by tooling that runs before any import exists.
  'package.json',
  // The platform's own mandated project config must point editors at its named schema.
  `${PLATFORM_SLUG}.jsonc`,
])

const NAME = new RegExp(`\\b${PLATFORM_NAME}\\b|\\b${PLATFORM_SLUG}\\b`, 'i')

const leaks: string[] = []
for (const rel of new Glob('**/*.{ts,tsx,js,mjs,json,py,sh}').scanSync({ cwd: ROOT })) {
  if (rel.includes('node_modules') || rel.startsWith('.git/') || rel.startsWith('hub/web/dist/'))
    continue
  // Run artifacts are gitignored vendor output, not source: a sandboxed worker's
  // session context quotes the canon that opens with the name. Policing them
  // would keep this check red after every run and teach everyone to skip it.
  if (rel.startsWith('orchestrator/runs/')) continue
  if (ALLOWED.has(rel)) continue
  // A lockfile records dependency names it did not choose.
  if (rel.endsWith('bun.lock') || rel.endsWith('package-lock.json')) continue

  const src = readFileSync(`${ROOT}/${rel}`, 'utf8')
  src.split('\n').forEach((line, i) => {
    if (!NAME.test(line)) return
    // A comment is prose: see the header. `*` covers block-comment
    // continuation lines, which is how most of these are written.
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) return
    // A PATH is where this machine keeps the checkout, not a use of the brand.
    // Those move when the directory moves and are not the leak this looks for.
    if (line.includes('/Projects/')) return
    leaks.push(`${rel}:${i + 1}\n    ${line.trim().slice(0, 110)}`)
  })
}

if (leaks.length) {
  console.error(
    `the platform name belongs in shared/brand.ts and nowhere else in code —\n` +
      `${leaks.length} literal(s) found:\n\n${leaks.join('\n')}\n\n` +
      `Import PLATFORM_NAME instead, or add a reason to ALLOWED in this file.`,
  )
  process.exit(1)
}
console.log(`brand   ${PLATFORM_NAME} is written once, in shared/brand.ts`)
