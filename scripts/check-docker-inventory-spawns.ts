#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const EXECUTABLE = 'orchestrator/src/resources/docker-executable.ts'

export function dockerExecutableLiteralBypasses(source: string, fileName: string): string[] {
  if (fileName === EXECUTABLE) return []
  if (!source.includes("'docker'") && !source.includes('"docker"') && !source.includes('`docker`'))
    return []
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  )
  const failures: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.StringLiteral ||
        token === ts.SyntaxKind.NoSubstitutionTemplateLiteral) &&
      scanner.getTokenValue() === 'docker'
    ) {
      const line = source.slice(0, scanner.getTokenPos()).split('\n').length
      failures.push(`${fileName}:${line}: Docker executable literals must use DOCKER_EXECUTABLE`)
    }
  }
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
