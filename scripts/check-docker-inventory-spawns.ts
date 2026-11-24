#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const EXECUTABLE = 'orchestrator/src/resources/docker-executable.ts'

export function dockerExecutableLiteralBypasses(source: string, fileName: string): string[] {
  if (fileName === EXECUTABLE) return []
  if (!source.includes('docker')) return []
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const failures: string[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      node.text === 'docker'
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      failures.push(`${fileName}:${line}: Docker executable literals must use DOCKER_EXECUTABLE`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return failures
}

function sourceFiles(): string[] {
  return [...new Glob('orchestrator/src/**/*.ts').scanSync({ cwd: ROOT, onlyFiles: true })].filter(
    (path) => !path.endsWith('.test.ts') && path !== EXECUTABLE,
  )
}

if (import.meta.main) {
  const failures = sourceFiles().flatMap((path) =>
    dockerExecutableLiteralBypasses(readFileSync(`${ROOT}/${path}`, 'utf8'), path),
  )
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}
