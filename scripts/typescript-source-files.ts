import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function typescriptFiles(directory: string, includeTests: boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...typescriptFiles(path, includeTests))
    else if (includeTests ? entry.name.endsWith('.ts') : isProductionTypeScriptFile(entry.name))
      files.push(path)
  }
  return files
}

export const isProductionTypeScriptFile = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts')

export const productionTypeScriptFiles = (directory: string): string[] =>
  typescriptFiles(directory, false)

export const productionTypeScriptFilesIncludingTests = (directory: string): string[] =>
  typescriptFiles(directory, true)
