const fs = require('fs');
const path = require('path');

// Get manifest files from architecture.ts
const content = fs.readFileSync('scripts/architecture.ts', 'utf8');
const manifestFiles = new Set();

// Find all module file references
const moduleRegex = /module\(['"]([^'"]+)['"]/g;
let match;
while ((match = moduleRegex.exec(content)) !== null) {
  manifestFiles.add(match[1]);
}

// Also check ... in architecture-boundaries.ts for some files
const boundariesContent = fs.readFileSync('scripts/architecture-boundaries.ts', 'utf8');

// Get all .ts files under orchestrator/src and hub/src
let foundCount = 0;
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      const rel = fullPath.replace(/\\/g, '/');
      // Skip test files
      if (rel.includes('/test/') || rel.includes('.test.') || rel.includes('.spec.')) continue;
      
      if (!manifestFiles.has(rel)) {
        console.log(rel);
        foundCount++;
      }
    }
  }
}

walk('orchestrator/src');
walk('hub/src');

console.error(`Total undeclared: ${foundCount}`, process.stderr.write ? '' : '');