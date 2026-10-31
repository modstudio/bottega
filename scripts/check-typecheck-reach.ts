#!/usr/bin/env bun
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { CHECK_LEGS } from './check-plan.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

/** Return tracked TypeScript sources absent from every resolved typecheck file set. */
export function uncoveredTypeScriptPaths(
  trackedPaths: readonly string[],
  resolvedFileSets: readonly (readonly string[])[],
): string[] {
  const covered = new Set(resolvedFileSets.flat())
  return trackedPaths
    .filter((path) => /\.tsx?$/.test(path) && !covered.has(path))
    .sort((left, right) => left.localeCompare(right))
}

function resolvedTypecheckFileSets(root: string, configPaths: readonly string[]): string[][] {
  return configPaths.map((config) => {
    const configPath = resolve(root, config)
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (read.error) {
      throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
    }
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    )
    if (parsed.errors.length > 0) {
      throw new Error(
        parsed.errors
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
          .join('\n'),
      )
    }
    return parsed.fileNames.map((path) => relative(root, path))
  })
}

function trackedTypeScriptPaths(root: string): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '--', '*.ts', '*.tsx'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function currentTypecheckReach(root = ROOT): string[] {
  const configs = CHECK_LEGS.flatMap((leg) => [...leg.typecheckConfigs])
  return uncoveredTypeScriptPaths(
    trackedTypeScriptPaths(root),
    resolvedTypecheckFileSets(root, configs),
  )
}

if (import.meta.main) {
  const started = performance.now()
  const uncovered = currentTypecheckReach()
  if (uncovered.length > 0) {
    throw new Error(`tracked TypeScript sources have no typecheck leg:\n${uncovered.join('\n')}`)
  }
  console.log(
    `typecheck reach: all tracked sources covered in ${(performance.now() - started).toFixed(1)}ms`,
  )
}
