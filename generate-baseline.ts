import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Get manifest files from architecture.ts
const content = readFileSync('scripts/architecture.ts', 'utf8');
const manifestFiles = new Set<string>();

// Find all module file references
const moduleRegex = /module\(['"]([^'"]+)['"]/g;
let match;
while ((match = moduleRegex.exec(content)) !== null) {
  manifestFiles.add(match[1]);
}

// Get all .ts files under orchestrator/src and hub/src
const undeclared: string[] = [];
function walk(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      const rel = fullPath.replace(/\\/g, '/');
      // Skip test files
      if (rel.includes('/test/') || rel.includes('.test.') || rel.includes('.spec.') || rel.includes('fixture.')) continue;
      
      if (!manifestFiles.has(rel)) {
        undeclared.push(rel);
      }
    }
  }
}

walk('orchestrator/src');
walk('hub/src');

// Sort and output as JSON
undeclared.sort();
writeFileSync('scripts/quality/undeclared-modules-baseline.json', JSON.stringify(undeclared, null, 2));
console.log(`Generated baseline with ${undeclared.length} files`);