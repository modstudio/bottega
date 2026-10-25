import { Glob } from 'bun'
import { join } from 'node:path'

/**
 * Pure function to check which files are undeclared in the manifest.
 * 
 * @param manifestFiles - Set of files declared in the architecture manifest
 * @param baseline - Baseline of files that are currently undeclared (shrink-only)
 * @returns Array of violation messages for undeclared files
 */
export function architectureUndeclaredModules(
  manifestFiles: ReadonlySet<string>,
  baseline: readonly string[],
): string[] {
  const violations: string[] = []
  const baselineSet = new Set(baseline)

  // Check all production TypeScript files in orchestrator/src and hub/src
  const roots = ['orchestrator/src', 'hub/src'] as const
  
  for (const root of roots) {
    for (const relative of new Glob('**/*.{ts,tsx}').scanSync({ 
      cwd: join(process.cwd(), root) 
    })) {
      const file = `${root}/${relative}`
      
      // Skip test files and fixture files
      if (/(^|\/)tests?\//.test(file)) continue
      if (/\.test\.(?:ts|tsx)?$/.test(file)) continue
      if (/\.spec\.(?:ts|tsx)?$/.test(file)) continue
      if (/\.fixture\.(?:ts|tsx)?$/.test(file)) continue
      
      // File is declared in manifest, skip
      if (manifestFiles.has(file)) continue
      
      // File is in baseline, skip
      if (baselineSet.has(file)) continue
      
      // File is undeclared and not in baseline - this is a violation
      violations.push(
        `${file}: missing manifest module (canon 10-code: A module is one concern)`,
      )
    }
  }

  // Check for stale baseline entries (files that are now declared)
  for (const file of baseline) {
    // Skip test files and fixture files from baseline staleness check
    if (/(^|\/)tests?\//.test(file)) continue
    if (/\.(?:test|spec|fixture)\.[cm]?tsx?$/.test(file)) continue
    
    if (manifestFiles.has(file)) {
      violations.push(
        `${file}: stale baseline entry - remove from baseline (canon 10-code: A module is one concern)`,
      )
    }
  }

  return violations
}

/** Count undeclared files (not in manifest and not in baseline) */
export function countUndeclaredModules(
  manifestFiles: ReadonlySet<string>,
  baseline: readonly string[],
): number {
  const violations = architectureUndeclaredModules(manifestFiles, baseline)
  return violations.filter(v => !v.includes('stale baseline')).length
}
