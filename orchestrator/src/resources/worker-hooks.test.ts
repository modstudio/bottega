import { expect, test } from 'bun:test'
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installWorkerHook, recognizeWorkerHook } from './worker-hooks.ts'

const CURRENT_COMMIT_MSG =
  '#!/bin/sh\n# orch worker commit-msg hook\nexec \'/current/check-attribution\' "$1"\n'
const LEGACY_PRE_PUSH =
  '#!/bin/sh\necho "workers never push; the architect pushes after review" >&2\nexit 1\n'

test('worker hook recognition accepts current, marked, and legacy generated hooks', () => {
  expect(recognizeWorkerHook('commit-msg', CURRENT_COMMIT_MSG, CURRENT_COMMIT_MSG)).toBe('current')
  expect(
    recognizeWorkerHook(
      'commit-msg',
      '#!/bin/sh\n# orch worker commit-msg hook\nexec \'/old/check-attribution\' "$1"\n',
      CURRENT_COMMIT_MSG,
    ),
  ).toBe('orch-generated')
  expect(
    recognizeWorkerHook(
      'commit-msg',
      "#!/bin/sh\nexec '/old/bun' '--no-env-file' '/old/check-attribution.ts' \"$1\"\n",
      CURRENT_COMMIT_MSG,
    ),
  ).toBe('orch-generated')
  expect(
    recognizeWorkerHook(
      'commit-msg',
      "#!/bin/sh\nexec '/old/orch' '__check-attribution' \"$1\"\n",
      CURRENT_COMMIT_MSG,
    ),
  ).toBe('orch-generated')
  expect(
    recognizeWorkerHook(
      'pre-push',
      LEGACY_PRE_PUSH,
      `#!/bin/sh\n# orch worker pre-push hook\n${LEGACY_PRE_PUSH.slice('#!/bin/sh\n'.length)}`,
    ),
  ).toBe('orch-generated')
  expect(
    recognizeWorkerHook(
      'pre-push',
      `#!/bin/sh\n# orch worker pre-push hook\n${LEGACY_PRE_PUSH.slice('#!/bin/sh\n'.length)}`,
      '#!/bin/sh\n# orch worker pre-push hook\nnew hook\n',
    ),
  ).toBe('orch-generated')
})

test('worker hook recognition refuses content outside the generated shapes', () => {
  expect(recognizeWorkerHook('commit-msg', '#!/bin/sh\necho arbitrary\n', CURRENT_COMMIT_MSG)).toBe(
    'unrecognized',
  )
  expect(
    recognizeWorkerHook(
      'commit-msg',
      '#!/bin/sh\nexec \'/old/check-attribution\' "$1"\necho extra\n',
      CURRENT_COMMIT_MSG,
    ),
  ).toBe('unrecognized')
  expect(
    recognizeWorkerHook(
      'commit-msg',
      '#!/bin/sh\nexec \'/old/something-else\' "$1"\n',
      CURRENT_COMMIT_MSG,
    ),
  ).toBe('unrecognized')
})

test('worker hook installer atomically replaces a legacy hook with executable current content', () => {
  const hookDir = mkdtempSync(join(tmpdir(), 'orch-worker-hook-'))
  const installed = join(hookDir, 'commit-msg')
  try {
    writeFileSync(installed, '#!/bin/sh\nexec \'/old/check-attribution\' "$1"\n')

    installWorkerHook(hookDir, 'commit-msg', CURRENT_COMMIT_MSG)

    expect(readFileSync(installed, 'utf8')).toBe(CURRENT_COMMIT_MSG)
    accessSync(installed, constants.X_OK)
  } finally {
    rmSync(hookDir, { recursive: true, force: true })
  }
})

test('worker hook installer replaces the previous pre-push hook', () => {
  const hookDir = mkdtempSync(join(tmpdir(), 'orch-worker-hook-'))
  const installed = join(hookDir, 'pre-push')
  const current = '#!/bin/sh\n# orch worker pre-push hook\nnew hook\n'
  try {
    writeFileSync(installed, LEGACY_PRE_PUSH)

    installWorkerHook(hookDir, 'pre-push', current)

    expect(readFileSync(installed, 'utf8')).toBe(current)
    accessSync(installed, constants.X_OK)
  } finally {
    rmSync(hookDir, { recursive: true, force: true })
  }
})

test('worker hook installer refuses an unrecognized hook with both remedies', () => {
  const hookDir = mkdtempSync(join(tmpdir(), 'orch-worker-hook-'))
  const installed = join(hookDir, 'commit-msg')
  try {
    writeFileSync(installed, '#!/bin/sh\necho custom\n')

    expect(() => installWorkerHook(hookDir, 'commit-msg', CURRENT_COMMIT_MSG)).toThrow(
      `refusing to replace worker commit-msg hook ${installed}: it was not written by orch; ` +
        `remove ${installed} or run orch discard <run> for the chain`,
    )
  } finally {
    rmSync(hookDir, { recursive: true, force: true })
  }
})

test('worker hook installer leaves a current executable hook untouched', () => {
  const hookDir = mkdtempSync(join(tmpdir(), 'orch-worker-hook-'))
  const installed = join(hookDir, 'commit-msg')
  try {
    writeFileSync(installed, CURRENT_COMMIT_MSG)
    chmodSync(installed, 0o755)
    const inode = statSync(installed).ino

    installWorkerHook(hookDir, 'commit-msg', CURRENT_COMMIT_MSG)

    expect(statSync(installed).ino).toBe(inode)
  } finally {
    rmSync(hookDir, { recursive: true, force: true })
  }
})
