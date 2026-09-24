import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatSpellingFinding,
  spellingFindings,
  TYPOS_MINIMUM_VERSION,
  typosVersionRefusal,
} from './check-spelling.ts'

const fixture = readFileSync(join(import.meta.dir, 'fixtures/typos-findings.jsonl'), 'utf8')

describe('typos findings', () => {
  test('fixture JSON becomes the stable one-line report', () => {
    expect(spellingFindings(fixture).map(formatSpellingFinding)).toEqual([
      'notes/readme.md:4:8 teh -> the',
      'src/code.ts:12:1 cataloguee -> catalogue, catalogued',
    ])
  })

  test('non-finding JSON events do not become reports', () => {
    expect(spellingFindings('{"type":"binary","path":"image.png"}\n')).toEqual([])
  })

  test('malformed typo events are refused', () => {
    expect(() => spellingFindings('{"type":"typo","path":"a"}\n')).toThrow(
      'typos returned a malformed finding',
    )
  })
})

describe('typos preflight', () => {
  test('the named minimum and newer versions pass', () => {
    expect(TYPOS_MINIMUM_VERSION).toBe('1.50.0')
    expect(typosVersionRefusal('typos-cli 1.50.0', 'darwin')).toBeNull()
    expect(typosVersionRefusal('typos-cli 2.0.0', 'linux')).toBeNull()
  })

  test('missing and old versions name the platform remedy', () => {
    expect(typosVersionRefusal(null, 'darwin')).toContain('brew install typos-cli')
    expect(typosVersionRefusal('typos-cli 1.49.9', 'linux')).toContain('pipx install typos')
  })
})
