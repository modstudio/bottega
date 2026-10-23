import { describe, expect, test } from 'bun:test'
import {
  classifyDispatch,
  classifyWaitedRow,
  decideDriftVerdict,
  decideNightStop,
  driftNoteOpening,
  driftOutcomeLine,
  existingDriftNote,
  localDay,
  minutesOfDay,
  orderDocsDriftQueue,
  pickSpareAgent,
  planDriftEffects,
  SPARE_STOP_FAILURE_KINDS,
  selectDocsDriftQueue,
  spareAgentEligible,
  spareDispatchArgv,
  spareNightLabel,
  spareNightSummary,
  spareWaitArgv,
  spareWindowMinutes,
  writeFailureLine,
} from './spare-decisions.ts'

describe('spare eligibility', () => {
  test('only a free, enabled agent is spare', () => {
    expect(spareAgentEligible({ name: 'or-free', billing: 'free', enabled: true })).toBe(true)
    expect(spareAgentEligible({ name: 'or-free', billing: 'free', enabled: false })).toBe(false)
    expect(spareAgentEligible({ name: 'or-free', billing: 'free' })).toBe(false)
    expect(spareAgentEligible({ name: 'codex', billing: 'subscription', enabled: true })).toBe(
      false,
    )
    expect(spareAgentEligible({ name: 'deepseek', billing: 'metered', enabled: true })).toBe(false)
    expect(spareAgentEligible({ name: 'none', billing: 'none', enabled: true })).toBe(false)
  })

  test('pickSpareAgent returns the first eligible and never a paid one', () => {
    expect(
      pickSpareAgent([
        { name: 'codex', billing: 'subscription', enabled: true },
        { name: 'or-free', billing: 'free', enabled: true },
      ])?.name,
    ).toBe('or-free')
    expect(pickSpareAgent([{ name: 'codex', billing: 'subscription', enabled: true }])).toBeNull()
    expect(pickSpareAgent([{ name: 'or-free', billing: 'free', enabled: false }])).toBeNull()
  })
})

describe('decideNightStop', () => {
  const base = { elapsedMinutes: 10, windowMinutes: 420, pending: 3, lastFailureKind: null }

  test('keeps working inside the window with a queue and no failure', () => {
    expect(decideNightStop(base)).toEqual({ stop: false, reason: null })
  })

  test('stops at the window end', () => {
    expect(decideNightStop({ ...base, elapsedMinutes: 420 })).toEqual({
      stop: true,
      reason: 'window',
    })
  })

  test('stops on each budget failure kind', () => {
    for (const lastFailureKind of SPARE_STOP_FAILURE_KINDS) {
      expect(decideNightStop({ ...base, lastFailureKind })).toEqual({
        stop: true,
        reason: 'budget',
      })
    }
  })

  test('a non-budget failure does not end the night', () => {
    expect(decideNightStop({ ...base, lastFailureKind: 'harness' })).toEqual({
      stop: false,
      reason: null,
    })
  })

  test('stops on an empty queue', () => {
    expect(decideNightStop({ ...base, pending: 0 })).toEqual({ stop: true, reason: 'empty' })
  })

  test('a finding that could not be recorded ends the night', () => {
    expect(decideNightStop({ ...base, writeFailed: true })).toEqual({
      stop: true,
      reason: 'write',
    })
  })

  test('the window outranks everything', () => {
    expect(
      decideNightStop({
        elapsedMinutes: 500,
        windowMinutes: 420,
        pending: 0,
        lastFailureKind: 'quota',
      }),
    ).toEqual({ stop: true, reason: 'window' })
  })

  test('a budget failure outranks an empty queue', () => {
    expect(
      decideNightStop({
        elapsedMinutes: 1,
        windowMinutes: 420,
        pending: 0,
        lastFailureKind: 'quota',
      }),
    ).toEqual({ stop: true, reason: 'budget' })
  })
})

describe('the window', () => {
  test('wraps midnight', () => {
    expect(spareWindowMinutes(minutesOfDay('22:00'), minutesOfDay('05:00'))).toBe(7 * 60)
    expect(spareWindowMinutes(minutesOfDay('01:00'), minutesOfDay('04:30'))).toBe(210)
  })

  test('rejects a clock value that is not HH:MM', () => {
    expect(() => minutesOfDay('5pm')).toThrow()
    expect(() => minutesOfDay('25:00')).toThrow()
  })
})

describe('localDay', () => {
  test('names the local calendar day, not the UTC day', () => {
    // Pin a zone behind UTC so the local and UTC days differ: 22:00 local on
    // 2026-10-22 is 02:00Z on 2026-10-23.
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const evening = new Date(2026, 9, 22, 22, 0, 0)
      expect(evening.getUTCDate()).not.toBe(evening.getDate())
      expect(localDay(evening)).toBe('2026-10-22')
      expect(localDay(new Date(2026, 0, 5, 0, 30, 0))).toBe('2026-01-05')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})

describe('orderDocsDriftQueue', () => {
  test('least recently checked first, never-checked ahead of all', () => {
    const ordered = orderDocsDriftQueue([
      { slug: 'recent', checkedAtMs: 300 },
      { slug: 'never', checkedAtMs: null },
      { slug: 'oldest', checkedAtMs: 100 },
      { slug: 'also-never', checkedAtMs: null },
    ])
    expect(ordered.map((d) => d.slug)).toEqual(['never', 'also-never', 'oldest', 'recent'])
  })
})

describe('selectDocsDriftQueue', () => {
  const doc = (over: Partial<Parameters<typeof selectDocsDriftQueue>[0][number]>) => ({
    slug: 'doc',
    scope: 'project',
    kind: 'article',
    checkedAtMs: null,
    project: 'acme',
    path: '/tmp/acme',
    visibility: 'public',
    visibilityRepository: 'acme/widget',
    currentRepository: 'acme/widget',
    ...over,
  })

  test('admits only public documents on their verified repository, oldest check first', () => {
    const selected = selectDocsDriftQueue([
      doc({ slug: 'private', visibility: 'private' }),
      doc({ slug: 'unverified', visibilityRepository: null }),
      doc({ slug: 'moved', currentRepository: 'acme/fork' }),
      doc({ slug: 'checked', checkedAtMs: 500 }),
      doc({ slug: 'never' }),
    ])
    expect(selected.map((d) => d.slug)).toEqual(['never', 'checked'])
  })

  test('never queues a working document or a non-project document', () => {
    const selected = selectDocsDriftQueue([
      doc({ slug: 'working', kind: 'working' }),
      doc({ slug: 'job-doc', scope: 'job' }),
      doc({ slug: 'global-doc', scope: 'global' }),
      doc({ slug: 'article' }),
    ])
    expect(selected.map((d) => d.slug)).toEqual(['article'])
  })
})

describe('decideDriftVerdict', () => {
  // A representative contract-valid verify-claim reply, built to
  // VERIFY_CLAIM_SCHEMA by a real run's output: the false verdict is the drift.
  const contractReply = JSON.stringify({
    verdict: 'false',
    provenance: { canon_source: 'live database' },
  })

  test('a false verdict is drift', () => {
    expect(decideDriftVerdict(contractReply)).toEqual({ kind: 'drift' })
  })

  test('a true verdict is clean', () => {
    expect(
      decideDriftVerdict('{"verdict": "true", "provenance": {"canon_source": "mirror"}}'),
    ).toEqual({ kind: 'clean' })
  })

  test('an undecidable verdict is no evidence', () => {
    expect(
      decideDriftVerdict('{"verdict": "undecidable", "provenance": {"canon_source": "unknown"}}'),
    ).toEqual({ kind: 'no-evidence' })
  })

  test('a fenced contract reply is still read', () => {
    expect(decideDriftVerdict(`\`\`\`json\n${contractReply}\n\`\`\``)).toEqual({ kind: 'drift' })
  })

  test('a malformed reply is no evidence', () => {
    expect(
      decideDriftVerdict('{"verdict": "maybe", "provenance": {"canon_source": "mirror"}}'),
    ).toEqual({ kind: 'no-evidence' })
    expect(decideDriftVerdict('{"verdict": "true"}')).toEqual({ kind: 'no-evidence' })
    expect(decideDriftVerdict('{"verdict": "true", "provenance": {}}')).toEqual({
      kind: 'no-evidence',
    })
    expect(decideDriftVerdict('VERDICT: DRIFT\n- something is stale')).toEqual({
      kind: 'no-evidence',
    })
  })

  test('a missing reply is no evidence', () => {
    expect(decideDriftVerdict('')).toEqual({ kind: 'no-evidence' })
  })

  test('the abandoned drift contract is not read as drift', () => {
    expect(
      decideDriftVerdict('{"drift": true, "claims": [{"claim": "x", "evidence": "y"}]}'),
    ).toEqual({ kind: 'no-evidence' })
  })
})

describe('planDriftEffects', () => {
  test('no evidence changes nothing and does not mark the document checked', () => {
    expect(planDriftEffects({ kind: 'no-evidence' }, false)).toEqual({
      markChecked: false,
      note: null,
    })
    expect(planDriftEffects({ kind: 'no-evidence' }, true)).toEqual({
      markChecked: false,
      note: null,
    })
  })

  test('a clean reply marks the document checked and files nothing', () => {
    expect(planDriftEffects({ kind: 'clean' }, false)).toEqual({
      markChecked: true,
      note: null,
    })
  })

  test('drift marks the document checked and files a note or a sighting', () => {
    expect(planDriftEffects({ kind: 'drift' }, false)).toEqual({
      markChecked: true,
      note: { action: 'new' },
    })
    expect(planDriftEffects({ kind: 'drift' }, true)).toEqual({
      markChecked: true,
      note: { action: 'same' },
    })
  })
})

describe('classifyWaitedRow', () => {
  test('a wait that timed out leaves the run unfinished', () => {
    expect(classifyWaitedRow({ waitExitCode: 2, status: 'running' })).toBe('unfinished')
    expect(classifyWaitedRow({ waitExitCode: 2, status: 'ok' })).toBe('unfinished')
  })

  test('an ok row is completed', () => {
    expect(classifyWaitedRow({ waitExitCode: 0, status: 'ok' })).toBe('completed')
  })

  test('a failed row read by exit 1 is failed', () => {
    expect(classifyWaitedRow({ waitExitCode: 1, status: 'failed' })).toBe('failed')
  })

  test('a non-terminal row is unfinished whatever the exit code says', () => {
    expect(classifyWaitedRow({ waitExitCode: 0, status: 'running' })).toBe('unfinished')
    expect(classifyWaitedRow({ waitExitCode: 1, status: null })).toBe('unfinished')
  })
})

describe('classifyDispatch', () => {
  test('a refused start that left no row is the capacity stop', () => {
    expect(classifyDispatch({ exitCode: 1, rowAppeared: false, identifierUsable: false })).toBe(
      'capacity',
    )
  })

  test('a zero exit that left no row is reported as it is, not as capacity', () => {
    expect(classifyDispatch({ exitCode: 0, rowAppeared: false, identifierUsable: false })).toBe(
      'rowless',
    )
  })

  test('a row with no usable identifier is unidentified', () => {
    expect(classifyDispatch({ exitCode: 0, rowAppeared: true, identifierUsable: false })).toBe(
      'unidentified',
    )
  })

  test('a row with a usable identifier is dispatched', () => {
    expect(classifyDispatch({ exitCode: 0, rowAppeared: true, identifierUsable: true })).toBe(
      'dispatched',
    )
  })
})

describe('spareNightSummary', () => {
  test('counts attempted, completed and write failures and takes the median duration', () => {
    expect(
      spareNightSummary({
        runs: [
          { status: 'ok', failureKind: null, latencyMs: 100 },
          { status: 'ok', failureKind: null, latencyMs: 300 },
          { status: 'failed', failureKind: 'harness', latencyMs: 200 },
        ],
        writeFailures: 1,
        stopReason: 'empty',
      }),
    ).toEqual({
      attempted: 3,
      completed: 2,
      medianDurationMs: 200,
      writeFailures: 1,
      stopReason: 'empty',
    })
  })

  test('averages the middle pair for an even count', () => {
    expect(
      spareNightSummary({
        runs: [
          { status: 'ok', failureKind: null, latencyMs: 100 },
          { status: 'ok', failureKind: null, latencyMs: 201 },
        ],
        writeFailures: 0,
        stopReason: 'window',
      }).medianDurationMs,
    ).toBe(151)
  })

  test('reports no median when nothing ran', () => {
    expect(spareNightSummary({ runs: [], writeFailures: 0, stopReason: 'empty' })).toEqual({
      attempted: 0,
      completed: 0,
      medianDurationMs: null,
      writeFailures: 0,
      stopReason: 'empty',
    })
  })
})

describe('dispatch argv', () => {
  test('always pins the agent, forbids failover and capacity waits, and asks for the run id', () => {
    const argv = spareDispatchArgv({
      runJob: 'verify-claim',
      prompt: 'audit doc-example',
      repo: 'acme/widget',
      agent: 'or-free',
      key: 'DEV-1676',
      label: spareNightLabel('docs-drift', '2026-10-23'),
    })
    expect(argv).toContain('--no-failover')
    expect(argv).toContain('--no-wait-capacity')
    expect(argv).toContain('--porcelain')
    expect(argv[argv.indexOf('--agent') + 1]).toBe('or-free')
    expect(argv[argv.indexOf('--key') + 1]).toBe('DEV-1676')
    expect(argv[argv.indexOf('--label') + 1]).toBe('spare:docs-drift:2026-10-23')
    expect(argv.slice(0, 4)).toEqual(['run', 'start', 'verify-claim', 'audit doc-example'])
  })
})

describe('wait argv', () => {
  test('waits on the printed run identifier, bounded by the window', () => {
    expect(spareWaitArgv('1234', 420)).toEqual(['run', 'wait', '1234', '--timeout', '420'])
  })

  test('a spent window still leaves a positive timeout', () => {
    expect(spareWaitArgv('1234', 0)).toEqual(['run', 'wait', '1234', '--timeout', '1'])
  })
})

describe('the lines the night prints for one document', () => {
  test('a reply with no evidence says so, and nothing is written', () => {
    expect(driftOutcomeLine({ slug: 'doc', verdict: { kind: 'no-evidence' } })).toBe(
      'spare: doc returned no usable evidence; nothing written',
    )
  })

  test('a verdict that wrote something says nothing at all', () => {
    expect(driftOutcomeLine({ slug: 'doc', verdict: { kind: 'clean' } })).toBeNull()
    expect(driftOutcomeLine({ slug: 'doc', verdict: { kind: 'drift' } })).toBeNull()
  })

  test('a write that failed names the write, the document and why it stopped', () => {
    expect(
      writeFailureLine({ slug: 'doc', write: 'the drift note', detail: 'note was refused' }),
    ).toBe('spare: the drift note for doc failed (note was refused); stopping the night')
  })
})

describe('existing drift note', () => {
  const notes = [
    { record_id: 'n1', text: 'unrelated finding' },
    { record_id: 'n2', text: 'docs-drift: other-doc (acme) contradicts the current tree' },
    { record_id: 'n3', text: 'docs-drift: feature-flags (acme) contradicts the current tree' },
  ]

  test('a first finding for a document has no note to sight', () => {
    expect(existingDriftNote(notes, { slug: 'new-doc', project: 'acme' })).toBeNull()
  })

  test('a repeat finding matches the note whose text opens with the identifier', () => {
    expect(existingDriftNote(notes, { slug: 'feature-flags', project: 'acme' })?.record_id).toBe(
      'n3',
    )
  })

  test('another document with the slug inside it is not a match', () => {
    const slugAsSubstring = [
      { record_id: 'n4', text: 'docs-drift: feature-flags-extra (acme) contradicts the tree' },
    ]
    expect(
      existingDriftNote(slugAsSubstring, { slug: 'feature-flags', project: 'acme' }),
    ).toBeNull()
  })

  test('a note that only mentions the identifier later in its text is not a match', () => {
    const mentionsLater = [
      { record_id: 'n5', text: 'reopened: docs-drift: feature-flags (acme) contradicts the tree' },
    ]
    expect(existingDriftNote(mentionsLater, { slug: 'feature-flags', project: 'acme' })).toBeNull()
  })

  test('another project with the same slug is not a match', () => {
    expect(existingDriftNote(notes, { slug: 'feature-flags', project: 'widget' })).toBeNull()
  })

  test('the opening names the slug and the project', () => {
    expect(driftNoteOpening('feature-flags', 'acme')).toBe('docs-drift: feature-flags (acme)')
  })
})
