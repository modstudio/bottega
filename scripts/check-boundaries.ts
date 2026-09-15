#!/usr/bin/env bun
/**
 * Concerns live side by side here; they do not reach into each other.
 * The only shared code is `shared/`, and it may import nothing back.
 *
 * This is checked rather than trusted, for the reason a sibling project's own boundary
 * guard exists: a rule nobody enforces is a rule that has already drifted.
 */
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { CONCERNS } from '../shared/brand.ts'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const violations: string[] = []

for (const concern of CONCERNS) {
  for (const rel of new Glob('**/*.{ts,tsx,js,mjs}').scanSync({ cwd: `${ROOT}/${concern}` })) {
    if (rel.includes('node_modules')) continue
    const file = `${concern}/${rel}`
    const src = readFileSync(`${ROOT}/${file}`, 'utf8')
    const imports = importSpecifiers(src)
    for (const spec of imports.specifiers) {
      if (!spec.startsWith('.')) continue
      // Resolve the specifier against the importing file, then see which
      // top-level concern it lands in.
      const dir = `${concern}/${rel}`.split('/').slice(0, -1).join('/')
      const parts = `${dir}/${spec}`.split('/')
      const out: string[] = []
      for (const p of parts) {
        if (p === '.' || p === '') continue
        if (p === '..') out.pop()
        else out.push(p)
      }
      const target = out[0]
      if (concern === 'hub' && rel.startsWith('web/') && target === 'hub' && out[1] !== 'web') {
        const resolved = out.join('/')
        const typeOnlyRouter =
          resolved === 'hub/src/trpc/router.ts' &&
          new RegExp(
            `import\\s+type\\s+[^\\n]+from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
          ).test(src)
        if (!typeOnlyRouter) {
          violations.push(
            `${file}\n    imports "${spec}" -> ${resolved}  (hub/web may import only the hub router type)`,
          )
        }
        continue
      }
      if (!target || target === concern || target === 'shared') continue
      if (CONCERNS.includes(target)) {
        violations.push(`${file}\n    imports "${spec}" -> ${target}/  (cross-concern)`)
      }
    }
    for (const expression of imports.unresolvedRelative) {
      violations.push(`${file}\n    has an unresolved relative import at ${expression}`)
    }
  }
}

// shared/ is shared because it depends on nobody.
for (const rel of new Glob('**/*.{ts,tsx,js,mjs}').scanSync({ cwd: `${ROOT}/shared` })) {
  const src = readFileSync(`${ROOT}/shared/${rel}`, 'utf8')
  const imports = importSpecifiers(src)
  for (const spec of imports.specifiers) {
    if (spec.startsWith('.') && spec.includes('..')) {
      violations.push(`shared/${rel}\n    imports "${spec}" — shared/ may not reach outside itself`)
    }
  }
  for (const expression of imports.unresolvedRelative) {
    violations.push(`shared/${rel}\n    has an unresolved relative import at ${expression}`)
  }
}

if (violations.length) {
  console.error(`check-boundaries: ${violations.length} violation(s)\n`)
  for (const v of violations) console.error(`  ${v}\n`)
  process.exit(1)
}
console.log(`check-boundaries: ok (${CONCERNS.join(', ')} + shared)`)
