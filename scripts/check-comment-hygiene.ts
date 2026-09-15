#!/usr/bin/env bun
/** Comments state the current rule and its reason; git holds their history. */
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOTS = ['orchestrator', 'hub', 'shared', 'scripts']
const GENERATED = /^(?:hub\/web\/src\/routeTree\.gen\.ts|.*(?:^|\/)migrations\/meta(?:\/|$))/
const SOURCE = /\.tsx?$/

export const HISTORY_PHRASE =
  /\b(?:used to (?:be|have)|formerly|back when|previously|was omitted|this replac(?:es|ed)|the first draft|restores the (?:earlier|old|previous))\b/gi

export type CommentHygieneFinding = {
  file: string
  line: number
  phrase: string
}

/** Block and line comment spans; a URL's `//` does not open a comment. */
export function commentSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  for (const re of [/\/\*[\s\S]*?\*\//g, /(?<!:)\/\/[^\n]*/g]) {
    for (const match of text.matchAll(re)) {
      spans.push([match.index, match.index + match[0].length])
    }
  }
  return spans
}

export function checkCommentBody(file: string, body: string): CommentHygieneFinding[] {
  const findings: CommentHygieneFinding[] = []
  for (const [start, end] of commentSpans(body)) {
    const comment = body.slice(start, end)
    for (const match of comment.matchAll(HISTORY_PHRASE)) {
      const offset = start + match.index
      findings.push({
        file,
        line: body.slice(0, offset).split('\n').length,
        phrase: match[0],
      })
    }
  }
  return findings
}

function trackedSources(root: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '--', ...ROOTS], { cwd: root })
  if (listed.exitCode !== 0) {
    throw new Error(`could not list tracked source files: ${listed.stderr.toString().trim()}`)
  }
  return listed.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((file) => SOURCE.test(file) && !GENERATED.test(file))
}

export function checkTrackedComments(root: string): CommentHygieneFinding[] {
  return trackedSources(root).flatMap((file) =>
    checkCommentBody(file, readFileSync(resolve(root, file), 'utf8')),
  )
}

if (import.meta.main) {
  const root = resolve(new URL('..', import.meta.url).pathname)
  const findings = checkTrackedComments(root)
  if (findings.length) {
    console.error('comment hygiene check failed')
    for (const finding of findings) {
      console.error(
        `${finding.file}:${finding.line}: "${finding.phrase}" — state what the code does now and why; git holds what it used to be.`,
      )
    }
    process.exit(1)
  }
  console.log('comment hygiene check passed')
}
