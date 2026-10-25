import { modules } from './scripts/architecture.ts'; Bun.write('module-count.txt', String(modules.length));
