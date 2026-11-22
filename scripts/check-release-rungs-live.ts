#!/usr/bin/env bun

import { fileURLToPath } from 'node:url'
import { readLiveCommit } from '../orchestrator/src/release/live-reading.ts'
import { tagRungLiveDecision } from '../orchestrator/src/release/release-decision.ts'
import { entryClosureAtCommit } from '../orchestrator/src/release/release-entry-closure.ts'
import { decideRequiredRungs } from '../orchestrator/src/release/release-required.ts'
import { readTrackedReleaseRungs } from '../orchestrator/src/release/release-rungs.ts'
import { gitAt } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function gitOutput(args: string[]): string {
  const result = gitAt(root, args)
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}; fetch missing commits or repair the checkout, then retry`,
    )
  }
  return result.stdout.trim()
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = gitAt(root, ['merge-base', '--is-ancestor', ancestor, descendant])
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${result.stderr.trim() || `exit ${result.code}`}; fetch missing commits or repair the checkout, then retry`,
  )
}

function changedPaths(from: string, to: string): string[] {
  const args = nulPathListArgs(['diff', '--name-only', `${from}..${to}`, '--'])
  const result = gitAt(root, args)
  if (result.code !== 0) {
    throw new Error(
      `git diff --name-only ${from}..${to} failed: ${result.stderr.trim() || `exit ${result.code}`}; fetch missing commits or repair the checkout, then retry`,
    )
  }
  return splitNulPaths(result.stdout)
}

function requiringPaths(
  rung: string,
  paths: readonly string[],
  rungs: ReturnType<typeof readTrackedReleaseRungs>['rungs'],
  closure: ReturnType<typeof entryClosureAtCommit>,
): string[] {
  return paths.filter((path) => decideRequiredRungs(rungs, [path], closure).includes(rung))
}

function main(): void {
  const [tag, ...extra] = Bun.argv.slice(2)
  if (!tag || extra.length > 0)
    throw new Error('usage: bun scripts/check-release-rungs-live.ts <tag>')
  const tagCommit = gitOutput(['rev-parse', '--verify', `${tag}^{commit}`])
  const tracked = readTrackedReleaseRungs(root)
  const entries = [...new Set(tracked.rungs.flatMap((rung) => rung.entryPoints ?? []))]
  const closure =
    entries.length > 0 ? entryClosureAtCommit({ path: root }, tagCommit, entries) : new Map()
  const refusals: string[] = []

  for (const rung of tracked.rungs) {
    const reading = readLiveCommit(rung.live, root)
    if (!reading.ok) {
      refusals.push(
        tagRungLiveDecision({
          rung: rung.name,
          tagCommit,
          probe: { error: reading.failure },
          liveContainsTag: false,
          tagContainsLive: false,
          requiringPaths: [],
        }).message,
      )
      continue
    }
    try {
      const liveContainsTag = isAncestor(tagCommit, reading.commit)
      const tagContainsLive = isAncestor(reading.commit, tagCommit)
      const paths = tagContainsLive
        ? requiringPaths(rung.name, changedPaths(reading.commit, tagCommit), tracked.rungs, closure)
        : []
      const decision = tagRungLiveDecision({
        rung: rung.name,
        tagCommit,
        probe: { commit: reading.commit },
        liveContainsTag,
        tagContainsLive,
        requiringPaths: paths,
      })
      if (!decision.ok) refusals.push(decision.message)
    } catch (error) {
      refusals.push(
        tagRungLiveDecision({
          rung: rung.name,
          tagCommit,
          probe: {
            error: `could not compare live commit ${reading.commit}: ${error instanceof Error ? error.message : String(error)}`,
          },
          liveContainsTag: false,
          tagContainsLive: false,
          requiringPaths: [],
        }).message,
      )
    }
  }

  if (refusals.length > 0) throw new Error(refusals.join('\n'))
  console.log(
    `all ${tracked.rungs.length} hosted release rungs are live for ${tag} at ${tagCommit}`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
