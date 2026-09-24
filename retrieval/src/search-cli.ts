#!/usr/bin/env bun
import { resolve } from 'node:path'
// concern: retrieval-search-cli
/** Presents the stable semantic document-search contract. */
import {
  CodeSearchOutputSchema,
  DocSearchOutputSchema,
  OrchProjectListSchema,
} from '../../shared/orch-contract.ts'
import { searchCode } from './code-search.ts'
import { search } from './search.ts'
import { endpointsFromEnvironment, probeEndpointStatuses } from './services/endpoints.ts'

function usage(): never {
  throw new Error(
    'usage: bun retrieval/src/search-cli.ts "<query>" [--k N] [--json] [--code --project <path>]',
  )
}

async function registeredCodeProject(path: string): Promise<{ name: string; path: string }> {
  const child = Bun.spawn(
    [resolve(import.meta.dir, '../../bin/orch'), 'project', 'list', '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || 'could not read the project register')
  const projects = OrchProjectListSchema.parse(JSON.parse(stdout))
  const requested = resolve(path)
  const project = projects.find((candidate) => resolve(candidate.path) === requested)
  if (!project) throw new Error(`no registered project has checkout ${requested}`)
  if (project.settings.search?.code !== true) {
    throw new Error(
      `project ${project.name} has not opted into code search; set settings.search.code to true`,
    )
  }
  return { name: project.name, path: project.path }
}

export function formatRefreshSummary(refresh: {
  embedded: number
  deleted: number
  unchanged: number
  stale: number
}): string {
  return `refresh: ${refresh.embedded} embedded, ${refresh.deleted} deleted, ${refresh.unchanged} unchanged, ${refresh.stale} stale`
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--check') {
    const statuses = await probeEndpointStatuses(endpointsFromEnvironment(process.env))
    for (const status of statuses) {
      console.log(`${status.kind} ${status.url} ${status.reachable ? 'reachable' : 'unreachable'}`)
    }
    if (statuses.some((status) => !status.reachable)) process.exitCode = 1
    return
  }
  const query = argv[0]
  if (!query || query.startsWith('--')) usage()
  let k = 5
  let json = false
  let code = false
  let projectPath: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') json = true
    else if (argument === '--code') code = true
    else if (argument === '--project') {
      projectPath = argv[++index]
      if (!projectPath) usage()
    } else if (argument === '--k') {
      const value = argv[++index]
      if (!value || !/^\d+$/.test(value)) usage()
      k = Number(value)
    } else usage()
  }
  if (code && !projectPath) usage()
  if (!code && projectPath) usage()
  const output = code
    ? CodeSearchOutputSchema.parse(
        await searchCode(await registeredCodeProject(projectPath!), query, k),
      )
    : DocSearchOutputSchema.parse(await search(query, k))
  if (json) {
    console.log(JSON.stringify(output))
    return
  }
  console.log(formatRefreshSummary(output.refresh))
  for (const result of output.results) {
    if ('path' in result) {
      console.log(`${result.project}:${result.path}:${result.startLine}-${result.endLine}`)
      console.log(`  ${result.snippet}${result.truncated ? '…' : ''}`)
      console.log(`  embedding ${result.embeddingScore} · rerank ${result.rerankScore}`)
      continue
    }
    console.log(
      `${result.scope}/${result.subject ?? '_'}/${result.slug} · ${result.headingPath.join(' > ') || result.title}`,
    )
    console.log(`  ${result.snippet}${result.truncated ? '…' : ''}`)
    console.log(`  embedding ${result.embeddingScore} · rerank ${result.rerankScore}`)
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
