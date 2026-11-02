// concern: prose
/** Lazy, compact lookups over the vendored prose correction and allow lists. */

import typosText from '../../typos.toml' with { type: 'text' }
import britishSpellingsText from './british-spellings.txt' with { type: 'text' }
import dictionaryText from './dictionary.txt' with { type: 'text' }
import misspellingsText from './misspellings.txt' with { type: 'text' }

type CsvLookup = { offsets: Uint32Array; text: string }

let misspellings: CsvLookup | null = null
let britishSpellings: CsvLookup | null = null
let allowedWords: Set<string> | null = null

function indexedCsv(text: string): CsvLookup {
  let rows = text.length === 0 ? 0 : 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && index + 1 < text.length) rows += 1
  }
  const offsets = new Uint32Array(rows)
  let row = 1
  for (let index = 0; index < text.length && row < rows; index += 1) {
    if (text.charCodeAt(index) === 10) offsets[row++] = index + 1
  }
  return { offsets, text }
}

function compareKey(word: string, text: string, start: number, comma: number): number {
  const length = comma - start
  const sharedLength = Math.min(word.length, length)
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = word.charCodeAt(index) - text.charCodeAt(start + index)
    if (difference !== 0) return difference
  }
  return word.length - length
}

function correction(lookup: CsvLookup, word: string): string | null {
  let low = 0
  let high = lookup.offsets.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const start = lookup.offsets[middle] ?? 0
    const comma = lookup.text.indexOf(',', start)
    const comparison = compareKey(word, lookup.text, start, comma)
    if (comparison < 0) high = middle - 1
    else if (comparison > 0) low = middle + 1
    else {
      const nextComma = lookup.text.indexOf(',', comma + 1)
      const newline = lookup.text.indexOf('\n', comma + 1)
      const end = Math.min(
        nextComma < 0 ? lookup.text.length : nextComma,
        newline < 0 ? lookup.text.length : newline,
      )
      return lookup.text.slice(comma + 1, end).replace(/\r$/, '')
    }
  }
  return null
}

function typosAllowWords(): string[] {
  const words: string[] = []
  let included = false
  for (const line of typosText.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1]
    if (section !== undefined) {
      included = section === 'default.extend-words' || section === 'default.extend-identifiers'
      continue
    }
    if (!included || /^\s*(?:#|$)/.test(line)) continue
    const key = line.match(/^\s*([^=]+?)\s*=/)?.[1]?.trim()
    if (key) words.push(key.replace(/^['"]|['"]$/g, '').toLowerCase())
  }
  return words
}

function loadedAllowedWords(): Set<string> {
  if (allowedWords === null) {
    allowedWords = new Set(typosAllowWords())
    for (const line of dictionaryText.split(/\r?\n/)) {
      const word = line.trim()
      if (word && !word.startsWith('#')) allowedWords.add(word.toLowerCase())
    }
  }
  return allowedWords
}

export function misspellingCorrection(word: string): string | null {
  misspellings ??= indexedCsv(misspellingsText)
  return correction(misspellings, word)
}

export function americanSpelling(word: string): string | null {
  britishSpellings ??= indexedCsv(britishSpellingsText)
  return correction(britishSpellings, word)
}

export function isAllowedWord(word: string): boolean {
  return loadedAllowedWords().has(word)
}
