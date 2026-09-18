#!/usr/bin/env bun
import { readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HarnessMirrorEntry = { path: string; isSymlink: boolean; target?: string }

export function decideHarnessMirror(entries: HarnessMirrorEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.path === '.claude/settings.json') return []
    const folder = entry.path.match(/^\.claude\/([^/]+)$/)?.[1]
    if (folder && entry.isSymlink && entry.target === `../.agents/${folder}`) return []
    return [
      `${entry.path}: move it under .agents/ and symlink .claude/${folder ?? '<folder>'} to ../.agents/${folder ?? '<folder>'}`,
    ]
  })
}

function trackedClaudeEntries(root: string): HarnessMirrorEntry[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-s', '-z', '--', '.claude'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect tracked .claude paths: ${result.stderr.toString().trim()}`)
  }
  return result.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/)
      if (!match) throw new Error(`could not parse git ls-files entry ${JSON.stringify(line)}`)
      const path = match[2]!
      const isSymlink = match[1] === '120000'
      return { path, isSymlink, target: isSymlink ? readlinkSync(resolve(root, path)) : undefined }
    })
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const findings = decideHarnessMirror(trackedClaudeEntries(root))
  if (findings.length) {
    console.error(
      'harness mirror check failed: .claude may contain only harness config and mirrors',
    )
    for (const finding of findings) console.error(finding)
    process.exit(1)
  }
  console.log('harness mirror check passed')
}
