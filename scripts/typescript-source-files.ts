import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function typescriptFiles(directory: string, includeTests: boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...typescriptFiles(path, includeTests))
    else if (entry.name.endsWith('.ts') && (includeTests || !entry.name.endsWith('.test.ts')))
      files.push(path)
  }
  return files
}

export const productionTypeScriptFiles = (directory: string): string[] =>
  typescriptFiles(directory, false)

export const productionTypeScriptFilesIncludingTests = (directory: string): string[] =>
  typescriptFiles(directory, true)
