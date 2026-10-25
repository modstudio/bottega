
import { modules } from './scripts/architecture.ts';
import { Glob } from 'bun';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = '.';
const manifestFiles = new Set(modules.map(({ file }) => file));

const files: string[] = [];
for (const root of ['orchestrator/src', 'hub/src']) {
  for (const relative of new Glob('**/*.{ts,tsx}').scanSync({ cwd: ROOT + '/' + root })) {
    const file = root + '/' + relative;
    if (!file.includes('/test/') && !file.includes('.test.') && !file.includes('.spec.') && !file.includes('fixture.')) {
      files.push(file);
    }
  }
}

const undeclared = files.filter(f => !manifestFiles.has(f));
Bun.write('undeclared-files.txt', undeclared.sort().join('\n'));
console.log('Total:', files.length, 'Declared:', files.filter(f => manifestFiles.has(f)).length, 'Undeclared:', undeclared.length);

