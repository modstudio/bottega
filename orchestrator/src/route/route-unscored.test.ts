import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  newestTurnOutputPathSql,
  pendingForSession,
  UNSCORED_WHERE,
  unscoredCount,
  voidedSql,
} from '../evidence/evidence-query.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'

describe('what counts as unscored', () => {
  test('every terminal, served, non-probe, unjudged run is owed a judgment', () => {
    addRun({ agent: 'grok', job: 'craft' }) // owed
    addRun({ agent: 'grok', job: 'craft', probe: 1 }) // calibration
    addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'contract' }) // owed
    addRun({ agent: 'grok', job: 'craft', status: 'stale' }) // owed
    addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'auth' }) // unserved
    addRun({ agent: 'grok', job: 'craft', status: 'running' }) // not finished
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right') // judged

    expect(unscoredCount()).toBe(3)
  })

  test('doctor and pending cannot disagree, because they share the rule', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE record_id=?').run('S', mine)
    addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'contract', session: 'S' })
    expect(pendingForSession('S').length).toBe(2)
    expect(unscoredCount()).toBe(2)
  })

  test('the count honors the dashboard window', () => {
    const old = addRun({ agent: 'grok', job: 'craft' })
    db()
      .query('UPDATE run SET started_at=? WHERE record_id=?')
      .run(new Date(Date.now() - 60 * 86_400_000).toISOString(), old)
    addRun({ agent: 'grok', job: 'craft' })
    expect(unscoredCount()).toBe(2)
    expect(unscoredCount(new Date(Date.now() - 7 * 86_400_000).toISOString())).toBe(1)
  })
})

describe('the Stop hook and orchestrator agree on what is unscored', () => {
  const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, ' ')
  const normalizeSql = (sql: string) =>
    stripSqlComments(sql).replace(/\s+/g, ' ').trim().toLowerCase()

  const HOOK_ONLY_AND = [normalizeSql('r.session_id = ?')]
  const HOOK_ONLY_OR = [
    normalizeSql('review.record_id IS NOT NULL AND review.completed_at IS NULL'),
  ]

  const isWordChar = (c: string | undefined) => c != null && /[A-Za-z0-9_]/.test(c)

  const splitTopLevel = (sql: string, keyword: string): string[] => {
    const parts: string[] = []
    const kw = keyword.toLowerCase()
    let depth = 0
    let inString = false
    let start = 0
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i]
      if (inString) {
        if (c === "'") {
          if (sql[i + 1] === "'") i++
          else inString = false
        }
        continue
      }
      if (c === "'") {
        inString = true
        continue
      }
      if (c === '(') {
        depth++
        continue
      }
      if (c === ')') {
        depth--
        continue
      }
      if (
        depth === 0 &&
        sql.slice(i, i + kw.length).toLowerCase() === kw &&
        !isWordChar(sql[i - 1]) &&
        !isWordChar(sql[i + kw.length])
      ) {
        parts.push(sql.slice(start, i).trim())
        i += kw.length - 1
        start = i + 1
      }
    }
    parts.push(sql.slice(start).trim())
    return parts.filter(Boolean)
  }

  const unwrapOneOuter = (sql: string): string => {
    const s = sql.trim()
    if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') return s
    let depth = 0
    let inString = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (inString) {
        if (c === "'") {
          if (s[i + 1] === "'") i++
          else inString = false
        }
        continue
      }
      if (c === "'") {
        inString = true
        continue
      }
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) return i === s.length - 1 ? s.slice(1, -1).trim() : s
      }
    }
    return s
  }

  const unwrapAllOuter = (sql: string): string => {
    let s = sql.trim()
    for (;;) {
      const next = unwrapOneOuter(s)
      if (next === s) return s
      s = next
    }
  }

  const peelHookExemptions = (conjunct: string): string | null => {
    const trimmed = conjunct.trim()
    if (HOOK_ONLY_AND.includes(normalizeSql(trimmed))) return null

    const inner = unwrapOneOuter(trimmed)
    const disjuncts = splitTopLevel(inner, 'OR')
    if (disjuncts.length < 2) return trimmed

    const listed = (d: string) =>
      HOOK_ONLY_OR.includes(normalizeSql(d)) ||
      HOOK_ONLY_OR.includes(normalizeSql(unwrapAllOuter(d)))
    const kept = disjuncts.filter((d) => !listed(d))
    if (kept.length === disjuncts.length) return trimmed
    if (kept.length === 0) return null
    const [only] = kept
    if (only !== undefined && kept.length === 1) return only.trim()
    const joined = kept.join(' OR ')
    return trimmed.startsWith('(') ? `(${joined})` : joined
  }

  const comparableConjuncts = (where: string, peelHook: boolean): string[] => {
    const conjuncts = splitTopLevel(stripSqlComments(where), 'AND')
    const kept = peelHook
      ? conjuncts.map(peelHookExemptions).filter((c): c is string => c != null)
      : conjuncts
    return kept.map(normalizeSql).filter(Boolean)
  }

  const hookOwedWhere = (source: string) => {
    const start = source.indexOf('SELECT r.record_id, r.agent, r.job')
    if (start < 0) throw new Error('hook owed-run query not found')
    const from = source.indexOf('FROM run r LEFT JOIN', start)
    if (from < 0) throw new Error('hook owed-run outer FROM not found')
    const order = source.indexOf('ORDER BY r.number', start)
    const sql = source.slice(from, order)
    const whereAt = sql.search(/\bWHERE\b/)
    return sql.slice(whereAt + 'WHERE'.length)
  }

  const hookNewestTurnOutputPathSql = (source: string) => {
    const match = source.match(
      /CASE WHEN EXISTS \(SELECT 1 FROM run child[\s\S]*?ELSE r\.output_path END/,
    )
    if (!match) throw new Error('hook newest-turn output-path CASE not found')
    return match[0]
  }

  const liveHookWhere = () =>
    hookOwedWhere(
      readFileSync(
        fileURLToPath(new URL('../../hooks/score-reminder.py', import.meta.url)),
        'utf8',
      ),
    )

  test('Stop note reminders hand labels to system-health without triage commands', () => {
    const hook = ['../../hooks/score-reminder.py', '../../hooks/score_reminder_decision.py']
      .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
      .join('\n')
    expect(hook).toContain('row["label"]')
    expect(hook).toContain(`architects:${PLATFORM_SLUG}`)
    expect(hook).not.toContain('note keep')
    expect(hook).not.toContain('note drop')
  })

  test("the hook's not-evidence kinds match the canonical set", () => {
    const hook = readFileSync(
      fileURLToPath(new URL('../../hooks/score_reminder_decision.py', import.meta.url)),
      'utf8',
    )
    const literal = hook.match(/NOT_EVIDENCE = \{([\s\S]*?)\n\}/)?.[1]
    expect(literal).toBeDefined()
    const hookKinds = [...(literal?.matchAll(/["']([^"']+)["']/g) ?? [])].map((match) => match[1]!)
    expect(new Set(hookKinds)).toEqual(new Set([...NOT_EVIDENCE, 'unevidenced']))
  })

  test("the hook's newest-turn output-path rule matches the canonical SQL", () => {
    const hook = readFileSync(
      fileURLToPath(new URL('../../hooks/score-reminder.py', import.meta.url)),
      'utf8',
    )
    expect(normalizeSql(hookNewestTurnOutputPathSql(hook))).toBe(
      normalizeSql(newestTurnOutputPathSql('r')),
    )
  })

  const predicateDrift = (tsWhere: string, hookWhere: string) => {
    const ts = comparableConjuncts(tsWhere, false)
    const hook = comparableConjuncts(hookWhere, true)
    return {
      missingFromHook: ts.filter((c) => !hook.includes(c)),
      missingFromTs: hook.filter((c) => !ts.includes(c)),
    }
  }

  const orOntoLast = (where: string, disjunct: string) => {
    const parts = splitTopLevel(stripSqlComments(where), 'AND')
    return [...parts.slice(0, -1), `(${parts.at(-1)} OR ${disjunct})`].join(' AND ')
  }

  test('the comparator fails when either copy has a unique clause', () => {
    expect(predicateDrift('a AND b', 'a AND b AND extra')).toEqual({
      missingFromHook: [],
      missingFromTs: ['extra'],
    })
    expect(predicateDrift('a AND b AND extra', 'a AND b')).toEqual({
      missingFromHook: ['extra'],
      missingFromTs: [],
    })
    expect(predicateDrift("r.status = 'ok'", "r.session_id = ? AND r.status = 'ok'")).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test("UNSCORED_WHERE and the hook's owed-run predicate do not diverge in either direction", () => {
    /**
     * The hook is Python and cannot import the TypeScript definition, so its
     * predicate is a second copy — and it did what a second copy always does.
     * A one-directional test (hook contains every UNSCORED_WHERE clause) let
     * the hook grow `evidence_excluded IS NULL` while pending, unscoredCount,
     * monitor and `runs --unscored` did not. Session scope and the incomplete-
     * review reminder are hook-only; everything else must be the same set.
     */
    const hook = readFileSync(
      fileURLToPath(new URL('../../hooks/score-reminder.py', import.meta.url)),
      'utf8',
    )
    expect(predicateDrift(UNSCORED_WHERE, hookOwedWhere(hook))).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('a conjunct already inside an OR-group is drift when added at the top level, both ways', () => {
    const extra = 's.delivery IS NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(`${UNSCORED_WHERE} AND ${extra}`, hook)).toEqual({
      missingFromHook: predicateDrift(extra, '').missingFromHook,
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${extra}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', extra).missingFromTs,
    })
  })

  test('a genuinely unique clause is still caught, both ways', () => {
    const extra = 'r.stack IS NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(`${UNSCORED_WHERE} AND ${extra}`, hook)).toEqual({
      missingFromHook: predicateDrift(extra, '').missingFromHook,
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${extra}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', extra).missingFromTs,
    })
  })

  test('flipping IS NULL to IS NOT NULL is still caught', () => {
    const from = 'r.evidence_excluded IS NULL'
    const to = 'r.evidence_excluded IS NOT NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(UNSCORED_WHERE.replace(from, to), hook)).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, hook.replace(from, to))).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('reordering top-level conjuncts is not drift', () => {
    const reordered = splitTopLevel(stripSqlComments(UNSCORED_WHERE), 'AND')
      .toReversed()
      .join(' AND ')
    expect(predicateDrift(reordered, liveHookWhere())).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('whitespace changes are not drift', () => {
    const padded = stripSqlComments(UNSCORED_WHERE).replace(/\s+/g, '   \n')
    expect(predicateDrift(padded, liveHookWhere())).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test("an unlisted disjunct OR'd onto the delivery group is drift, both ways", () => {
    const unlisted = 'r.stack IS NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(orOntoLast(UNSCORED_WHERE, unlisted), hook)).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, orOntoLast(hook, unlisted))).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('a new AND conjunct that merely mentions r.session_id or review. is still caught', () => {
    const hook = liveHookWhere()
    const mentionsSession = "COALESCE(r.session_id, '') <> ''"
    const mentionsReview = 'review.record_id IS NULL'
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${mentionsSession}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', mentionsSession).missingFromTs,
    })
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${mentionsReview}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', mentionsReview).missingFromTs,
    })
  })

  test('empty-string exclusion is voided in SQL, matching IS NOT NULL not truthiness', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query("UPDATE run SET evidence_excluded='' WHERE record_id=?").run(id)
    const row = db()
      .query(`SELECT ${voidedSql('r')} AS voided FROM run r WHERE record_id=?`)
      .get(id) as { voided: number }
    expect(row).toEqual({ voided: 1 })
    const nulled = db()
      .query(`SELECT ${voidedSql('r')} AS voided FROM run r WHERE record_id=?`)
      .get(addRun({ agent: 'codex', job: 'implement', status: 'asking' })) as { voided: number }
    expect(nulled).toEqual({ voided: 0 })
  })
})
