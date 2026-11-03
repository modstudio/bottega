/** Keep the record-rehearsal image complete for every runtime import reached by its inline evals. */
import { readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

function relativeRuntimeImports(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return []
    const bindings = statement.importClause?.namedBindings
    if (
      bindings &&
      ts.isNamedImports(bindings) &&
      !statement.importClause?.name &&
      bindings.elements.every((element) => element.isTypeOnly)
    ) {
      return []
    }
    const value = statement.moduleSpecifier
    return ts.isStringLiteral(value) && value.text.startsWith('.') ? [value.text] : []
  })
}

function resolvedModule(from: string, specifier: string): string {
  const path = normalize(join(dirname(from), specifier))
    .split('\\')
    .join('/')
  return extname(path) ? path : `${path}.ts`
}

function evalSources(script: string): string[] {
  return [...script.matchAll(/bun\s+--eval\s+'([\s\S]*?)'/g)].map((match) => match[1]!)
}

function copiedSources(dockerfile: string): string[] {
  return dockerfile.split('\n').flatMap((line) => {
    const match = /^\s*COPY\s+(?:--\S+\s+)*(\S+)/.exec(line)
    return match ? [match[1]!.replace(/\/$/, '')] : []
  })
}

function isCopied(path: string, sources: readonly string[]): boolean {
  return sources.some((source) => path === source || path.startsWith(`${source}/`))
}

/** Find runtime-relative modules needed by inline eval imports but absent from an image. */
export function rehearsalImageImportFindings(
  script: string,
  dockerfile: string,
  readSource: (path: string) => string,
): string[] {
  const pending = evalSources(script).flatMap((source) => relativeRuntimeImports(source, '.'))
  const visited = new Set<string>()
  while (pending.length) {
    const path = resolvedModule('.', pending.pop()!)
    if (visited.has(path)) continue
    visited.add(path)
    const source = readSource(path)
    for (const specifier of relativeRuntimeImports(source, path)) {
      pending.push(resolvedModule(path, specifier))
    }
  }
  const copied = copiedSources(dockerfile)
  return [...visited].filter((path) => !isCopied(path, copied)).sort()
}

if (import.meta.main) {
  const scriptPath = 'orchestrator/deploy/backup/rehearse.sh'
  const dockerfilePath = 'orchestrator/deploy/backup/rehearse.Dockerfile'
  const readRepositorySource = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8')
  const findings = rehearsalImageImportFindings(
    readRepositorySource(scriptPath),
    readRepositorySource(dockerfilePath),
    readRepositorySource,
  )
  for (const path of findings) {
    console.error(`${dockerfilePath}: missing runtime import ${path}; add COPY ${path} ${path}`)
  }
  if (findings.length) process.exit(1)
}
