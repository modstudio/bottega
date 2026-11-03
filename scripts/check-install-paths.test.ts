import { expect, test } from 'bun:test'
import {
  distributionUnsafeInstallPathFindings,
  installPathFindings,
  installPathRemedyViolations,
} from './check-install-paths.ts'

test('refuses production paths built from a module directory', () => {
  expect(
    installPathFindings(
      "const root = resolve(import.meta.dir, '../..')\n",
      'orchestrator/src/example.ts',
    ),
  ).toEqual([{ path: 'orchestrator/src/example.ts', line: 1 }])
})

test('allows a module directory passed to an install-root resolver', () => {
  expect(
    installPathFindings(
      'const root = resolveInstallRoot(import.meta.dir, process.env)\n',
      'orchestrator/src/example.ts',
    ),
  ).toEqual([])
})

test('refuses module URLs used to construct paths or converted directly', () => {
  expect(
    installPathFindings(
      "const root = new URL('..', import.meta.url)\nconst path = fileURLToPath(import.meta.url)\n",
      'orchestrator/src/example.ts',
    ),
  ).toEqual([
    { path: 'orchestrator/src/example.ts', line: 1 },
    { path: 'orchestrator/src/example.ts', line: 2 },
  ])
})

test('allows a module URL passed directly to an install-root resolver', () => {
  expect(
    installPathFindings(
      'const root = resolveInstallRoot(import.meta.url, process.env)\n',
      'orchestrator/src/example.ts',
    ),
  ).toEqual([])
})

test('ignores build-tool config files', () => {
  expect(
    installPathFindings("const root = resolve(__dirname, '..')\n", 'hub/web/vite.config.ts'),
  ).toEqual([])
})

test('an allowlisted module identity does not allow a second module URL use', () => {
  expect(
    installPathFindings(
      'const dbSourcePath = fileURLToPath(import.meta.url)\nconst other = fileURLToPath(import.meta.url)\n',
      'hub/src/db.ts',
    ),
  ).toEqual([{ path: 'hub/src/db.ts', line: 2 }])
})

test('an allowlisted module identity cannot be widened by a wrapping path expression', () => {
  expect(
    installPathFindings(
      'const first = dirname(fileURLToPath(import.meta.url))\nconst second = join(fileURLToPath(import.meta.url), "db")\n',
      'hub/src/db.ts',
    ),
  ).toEqual([
    { path: 'hub/src/db.ts', line: 1 },
    { path: 'hub/src/db.ts', line: 2 },
  ])
})

test('ignores test files', () => {
  expect(
    installPathFindings(
      "const root = resolve(import.meta.dir, '../..')\n",
      'orchestrator/src/example.test.ts',
    ),
  ).toEqual([])
})

test('refuses checkout-only installer remedies and running-root binary joins', () => {
  expect(
    distributionUnsafeInstallPathFindings(
      "const remedy = 'run ops/install.sh'\nconst executable = join(runningRoot, 'bin', PLATFORM_SLUG)\n",
      'orchestrator/src/example.ts',
    ),
  ).toEqual([
    { path: 'orchestrator/src/example.ts', line: 1 },
    { path: 'orchestrator/src/example.ts', line: 2 },
  ])
})

test('allows the canonical owner inventory and running-copy executable resolver', () => {
  expect(
    distributionUnsafeInstallPathFindings(
      "const LAUNCHD_TEMPLATE_OWNERS = [{ command: 'ops/install.sh' }]\nconst argv = bottegaEntryArgv(PLATFORM_SLUG)\n",
      'orchestrator/src/example.ts',
    ),
  ).toEqual([])
})

test('distribution remedy baseline refuses growth and requires shrinking stale counts', () => {
  const baseline = { files: { 'shared/install-root.ts': 1 } }
  expect(
    installPathRemedyViolations(
      [
        { path: 'shared/install-root.ts', line: 1 },
        { path: 'new.ts', line: 2 },
      ],
      baseline,
    ),
  ).toEqual(['new.ts: distribution-unsafe install remedy count grew from 0 to 1'])
  expect(installPathRemedyViolations([], baseline)).toEqual([
    'shared/install-root.ts: distribution-unsafe install remedy baseline may only shrink; lower its count from 1 to 0',
  ])
})
