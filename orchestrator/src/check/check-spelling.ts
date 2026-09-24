export const TYPOS_MINIMUM_VERSION = '1.50.0'

export type SpellingFinding = {
  path: string
  line: number
  column: number
  word: string
  correction: string
}

type TyposFinding = {
  type?: unknown
  path?: unknown
  line_num?: unknown
  byte_offset?: unknown
  typo?: unknown
  corrections?: unknown
}

function parseFinding(value: TyposFinding): SpellingFinding | null {
  if (value.type !== 'typo') return null
  if (
    typeof value.path !== 'string' ||
    typeof value.line_num !== 'number' ||
    typeof value.byte_offset !== 'number' ||
    typeof value.typo !== 'string' ||
    !Array.isArray(value.corrections) ||
    value.corrections.some((correction) => typeof correction !== 'string')
  ) {
    throw new Error('typos returned a malformed finding')
  }
  return {
    path: value.path.replace(/^\.\//, ''),
    line: value.line_num,
    column: value.byte_offset + 1,
    word: value.typo,
    correction: value.corrections.join(', '),
  }
}

/** Convert typos JSON-lines output into the stable report used by orch. */
export function spellingFindings(jsonLines: string): SpellingFinding[] {
  return jsonLines
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => parseFinding(JSON.parse(line) as TyposFinding))
    .filter((finding): finding is SpellingFinding => finding !== null)
}

export function formatSpellingFinding(finding: SpellingFinding): string {
  return `${finding.path}:${finding.line}:${finding.column} ${finding.word} -> ${finding.correction}`
}

function versionParts(value: string): [number, number, number] | null {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function typosVersionRefusal(
  versionOutput: string | null,
  platform: NodeJS.Platform,
): string | null {
  const remedy = platform === 'darwin' ? 'brew install typos-cli' : 'pipx install typos'
  if (versionOutput === null) return `typos is required; install it with: ${remedy}`
  const actual = versionParts(versionOutput)
  const minimum = versionParts(TYPOS_MINIMUM_VERSION)!
  if (!actual) return `could not read the typos version; install it with: ${remedy}`
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! > minimum[index]!) return null
    if (actual[index]! < minimum[index]!) {
      return `typos ${actual.join('.')} is below minimum ${TYPOS_MINIMUM_VERSION}; upgrade it with: ${remedy}`
    }
  }
  return null
}
