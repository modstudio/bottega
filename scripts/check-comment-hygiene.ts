#!/usr/bin/env bun
/** Comments state the current rule and its reason; git holds their history. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['orchestrator', 'hub', 'shared', 'scripts', 'ops', 'local-stack']
const GENERATED = /^(?:hub\/web\/src\/routeTree\.gen\.ts|.*(?:^|\/)migrations\/meta(?:\/|$))/
const SOURCE = /\.(?:tsx?|sh)$/

const HISTORY_PHRASE =
  /\b(?:used to (?:be|have)|formerly|back when|previously|was omitted|this replac(?:es|ed)|the first draft|restores the (?:earlier|old|previous))\b/gi
const RETIRED_NAMES = ['devbox']
const RETIRED_NAME = new RegExp(RETIRED_NAMES.join('|'), 'gi')

export type CommentHygieneFinding = {
  file: string
  line: number
  phrase: string
}

/** TypeScript block and line comment spans; a URL's `//` does not open a comment. */
function typeScriptCommentSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  for (const re of [/\/\*[\s\S]*?\*\//g, /(?<!:)\/\/[^\n]*/g]) {
    for (const match of text.matchAll(re)) {
      spans.push([match.index, match.index + match[0].length])
    }
  }
  return spans
}

/** Shell comments run from `#` to the end of the line. */
function shellCommentSpans(text: string): [number, number][] {
  return [...text.matchAll(/#[^\n]*/g)].map((match) => [match.index, match.index + match[0].length])
}

export function checkCommentBody(file: string, body: string): CommentHygieneFinding[] {
  const findings: CommentHygieneFinding[] = []
  const spans = file.endsWith('.sh') ? shellCommentSpans(body) : typeScriptCommentSpans(body)
  for (const [start, end] of spans) {
    const comment = body.slice(start, end)
    for (const pattern of [HISTORY_PHRASE, RETIRED_NAME]) {
      for (const match of comment.matchAll(pattern)) {
        const offset = start + match.index
        findings.push({
          file,
          line: body.slice(0, offset).split('\n').length,
          phrase: match[0],
        })
      }
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

function checkTrackedComments(root: string): CommentHygieneFinding[] {
  return trackedSources(root).flatMap((file) =>
    checkCommentBody(file, readFileSync(resolve(root, file), 'utf8')),
  )
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
