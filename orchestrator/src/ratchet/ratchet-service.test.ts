import { describe, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeSupport, runReportsMode } from './ratchet-service.ts'

test('support files and directories are materialized into the mirror', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-ratchet-support-root-'))
  const mirror = mkdtempSync(join(tmpdir(), 'orch-ratchet-support-mirror-'))
  try {
    mkdirSync(join(root, 'config/plugins'), { recursive: true })
    writeFileSync(join(root, 'config/biome.jsonc'), 'working-tree configuration')
    writeFileSync(join(root, 'config/plugins/rule.ts'), 'working-tree plugin')

    materializeSupport(root, mirror, ['config/biome.jsonc', 'config/plugins'])

    const mirroredFile = join(mirror, 'config/biome.jsonc')
    const mirroredDirectory = join(mirror, 'config/plugins')
    expect(readFileSync(mirroredFile, 'utf8')).toBe('working-tree configuration')
    expect(lstatSync(mirroredFile).isSymbolicLink()).toBe(false)
    expect(lstatSync(mirroredDirectory).isSymbolicLink()).toBe(true)
    expect(realpathSync(mirroredDirectory)).toBe(realpathSync(join(root, 'config/plugins')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(mirror, { recursive: true, force: true })
  }
})

describe('reports mode failure policy', () => {
  const options = {
    cwd: '/unused',
    format: 'phpcs',
    staged: false,
    support: [],
  }
  const view = {
    facts: {
      renames: new Map<string, string>(),
      addedLines: new Map([['changed.php', [{ start: 5, end: 5 }]]]),
    },
  }

  test('a head report parse failure fails the verb', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orch-ratchet-reports-'))
    const headReport = join(directory, 'head.json')
    const baseReport = join(directory, 'base.json')
    try {
      writeFileSync(headReport, 'not json')
      writeFileSync(baseReport, JSON.stringify({ files: {} }))
      expect(() =>
        runReportsMode(options, directory, view, headReport, baseReport, console),
      ).toThrow(`head report ${headReport} failed: invalid PHPCS JSON`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a base report failure marks every head finding path unanalysed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orch-ratchet-reports-'))
    const headReport = join(directory, 'head.json')
    const baseReport = join(directory, 'base.json')
    const errors: string[] = []
    try {
      writeFileSync(
        headReport,
        JSON.stringify({
          files: {
            'stable.php': {
              messages: [{ line: 8, source: 'Old.Debt', message: 'Existing.', type: 'ERROR' }],
            },
            'changed.php': {
              messages: [{ line: 5, source: 'New.Debt', message: 'Added.', type: 'ERROR' }],
            },
          },
        }),
      )
      writeFileSync(baseReport, 'not json')

      expect(
        runReportsMode(options, directory, view, headReport, baseReport, {
          log() {},
          error(message) {
            errors.push(String(message))
          },
        }),
      ).toBe(false)
      expect(errors).toHaveLength(2)
      expect(errors[0]).toStartWith(
        `ratchet base report ${baseReport} failed: invalid PHPCS JSON:`,
      )
      expect(errors[1]).toBe('changed.php:5 New.Debt Added.; finding is on an added line')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
