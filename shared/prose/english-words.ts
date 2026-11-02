// concern: prose
/** Lazy adapter for the vendored English word list (word-list 4.1.0, MIT; see english-words.LICENSE). */

import englishWordsText from './english-words.txt' with { type: 'text' }

let englishWords: Set<string> | null = null

function loadedEnglishWords(): Set<string> {
  if (englishWords === null) englishWords = new Set(englishWordsText.split('\n'))
  return englishWords
}

export function isEnglishWord(word: string): boolean {
  return loadedEnglishWords().has(word)
}
