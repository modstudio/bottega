export type Finding = {
  file: string
  line: number
  rule: string
  message: string
  symbol?: string
  measure?: number
}

export function findingLine(finding: Finding): string {
  const location = finding.line === 0 ? finding.file : `${finding.file}:${finding.line}`
  return `${location} ${finding.rule} ${finding.message}`
}

export type LineRange = { start: number; end: number }

export type ChangeFacts = {
  renames: Map<string, string>
  addedLines: Map<string, LineRange[]>
}

type RefusedFinding = Finding &
  (
    | { reason: 'added-line' | 'count' | 'new-measured' }
    | { reason: 'grew'; previousMeasure: number }
  )

function normalizedMessage(message: string) {
  return message.replace(/\d+/g, '#')
}

function fingerprint(finding: Finding) {
  return JSON.stringify([finding.file, finding.rule, normalizedMessage(finding.message)])
}

export function introducedFindings(base: Finding[], head: Finding[]) {
  const remaining = new Map<string, number>()
  for (const finding of base) {
    const key = fingerprint(finding)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }

  return head.filter((finding) => {
    const key = fingerprint(finding)
    const count = remaining.get(key) ?? 0
    if (count === 0) return true
    remaining.set(key, count - 1)
    return false
  })
}

type IndexedFinding = { finding: Finding; index: number }

function groupKey(finding: Finding) {
  return JSON.stringify([finding.file, finding.rule])
}

function remapBaseFinding(finding: Finding, renames: Map<string, string>): Finding {
  for (const [headPath, basePath] of renames) {
    if (finding.file === basePath) return { ...finding, file: headPath }
  }
  return finding
}

function measuredGroups(findings: Finding[]): Map<string, IndexedFinding[]> {
  const groups = new Map<string, IndexedFinding[]>()
  for (const [index, finding] of findings.entries()) {
    if (finding.measure === undefined) continue
    const key = groupKey(finding)
    const group = groups.get(key) ?? []
    group.push({ finding, index })
    groups.set(key, group)
  }
  return groups
}

type MeasuredPair = { base: IndexedFinding; head: IndexedFinding }

function symbolPairs(base: IndexedFinding[], head: IndexedFinding[]) {
  const pairedBase = new Set<number>()
  const pairedHead = new Set<number>()
  const pairs: MeasuredPair[] = []
  for (const headFinding of head) {
    if (headFinding.finding.symbol === undefined) continue
    const baseFinding = base.find(
      (candidate) =>
        !pairedBase.has(candidate.index) &&
        candidate.finding.symbol !== undefined &&
        candidate.finding.symbol === headFinding.finding.symbol,
    )
    if (!baseFinding) continue
    pairedBase.add(baseFinding.index)
    pairedHead.add(headFinding.index)
    pairs.push({ base: baseFinding, head: headFinding })
  }
  return { pairs, pairedBase, pairedHead }
}

function byDescendingMeasure(left: IndexedFinding, right: IndexedFinding) {
  return right.finding.measure! - left.finding.measure!
}

function measuredGroupRefusals(base: IndexedFinding[], head: IndexedFinding[]) {
  const refused = new Map<number, RefusedFinding>()
  const symbol = symbolPairs(base, head)
  const remainingBase = base
    .filter((candidate) => !symbol.pairedBase.has(candidate.index))
    .sort(byDescendingMeasure)
  const remainingHead = head
    .filter((candidate) => !symbol.pairedHead.has(candidate.index))
    .sort(byDescendingMeasure)
  const pairs = [...symbol.pairs]
  for (const [position, headFinding] of remainingHead.entries()) {
    const baseFinding = remainingBase[position]
    if (baseFinding) pairs.push({ base: baseFinding, head: headFinding })
    else refused.set(headFinding.index, { ...headFinding.finding, reason: 'new-measured' })
  }
  for (const pair of pairs) {
    if (pair.head.finding.measure! <= pair.base.finding.measure!) continue
    refused.set(pair.head.index, {
      ...pair.head.finding,
      reason: 'grew',
      previousMeasure: pair.base.finding.measure!,
    })
  }
  return refused
}

function measuredRefusals(base: Finding[], head: Finding[]): Map<number, RefusedFinding> {
  const refused = new Map<number, RefusedFinding>()
  const baseGroups = measuredGroups(base)
  for (const [key, headGroup] of measuredGroups(head)) {
    for (const [index, finding] of measuredGroupRefusals(baseGroups.get(key) ?? [], headGroup)) {
      refused.set(index, finding)
    }
  }
  return refused
}

function isAddedLine(finding: Finding, addedLines: Map<string, LineRange[]>): boolean {
  return (addedLines.get(finding.file) ?? []).some(
    (range) => finding.line >= range.start && finding.line <= range.end,
  )
}

function unanalysedRefusals(head: Finding[], change: ChangeFacts, unanalysedBase: Set<string>) {
  const refused = new Map<number, RefusedFinding>()
  for (const [index, finding] of head.entries()) {
    if (unanalysedBase.has(finding.file) && isAddedLine(finding, change.addedLines)) {
      refused.set(index, { ...finding, reason: 'added-line' })
    }
  }
  return refused
}

export function ratchetDecision({
  base,
  head,
  change,
  unanalysedBase = new Set(),
}: {
  base: Finding[]
  head: Finding[]
  change: ChangeFacts
  unanalysedBase?: Set<string>
}): RefusedFinding[] {
  const remappedBase = base.map((finding) => remapBaseFinding(finding, change.renames))
  const comparableBase = remappedBase.filter((finding) => !unanalysedBase.has(finding.file))
  const comparableHead = head
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => !unanalysedBase.has(finding.file))
  const refused = unanalysedRefusals(head, change, unanalysedBase)
  for (const [index, finding] of measuredRefusals(
    comparableBase,
    comparableHead.map(({ finding }) => finding),
  )) {
    refused.set(comparableHead[index]!.index, finding)
  }
  const remaining = new Map<string, number>()

  for (const finding of comparableBase) {
    if (finding.measure !== undefined) continue
    const key = fingerprint(finding)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }

  for (const [index, finding] of head.entries()) {
    if (unanalysedBase.has(finding.file)) continue
    if (finding.measure !== undefined) continue
    if (isAddedLine(finding, change.addedLines)) {
      refused.set(index, { ...finding, reason: 'added-line' })
      continue
    }
    const key = fingerprint(finding)
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else refused.set(index, { ...finding, reason: 'count' })
  }

  return head.flatMap((_, index) => {
    const finding = refused.get(index)
    return finding ? [finding] : []
  })
}
