import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DOC_SCOPES } from '../../../shared/docs.ts'
import { renderRefusal } from '../../../shared/refusal.ts'
import { decideUserCanonImport } from '../canon/canon-write-gate.ts'
import { REFERENCE_GENERATOR } from './doc-generator.ts'
import {
  articleFieldRefusal,
  canonFindingsRefusal,
  canonFindingWarnings,
  canonRemovalRefusal,
  decideDocRevisionWrite,
  docWriteProjectName,
  globalCanonWriteTargets,
  MISSING_HOSTED_REVISION_REMEDY,
  referenceWriteRefusal,
  refuseArticleDelivery,
  refuseCanonWrite,
  refuseMismatchedDocProject,
  refuseOwnedDocAddress,
  refuseSettingsAddress,
  userCanonWriteTargets,
} from './doc-write-allowed.ts'

const finding = (rule: string, message: string, line = 1) => ({
  file: 'AGENTS.md',
  line,
  rule,
  message,
})

test('canon numeral findings warn while unambiguous prose findings refuse', () => {
  const numeral = finding('canon/numeral', 'prose contains numeral 11')
  expect(canonFindingsRefusal([numeral])).toBeNull()
  expect(canonFindingWarnings([numeral])).toEqual([
    'AGENTS.md:1 canon/numeral prose contains numeral 11',
  ])

  const decision = decideUserCanonImport({
    current: [{ slug: 'AGENTS.md', body: 'Current rule.' }],
    next: [
      {
        slug: 'AGENTS.md',
        body: 'Current rule. It was renamed under DEV-1863 on 2026-11-01.',
      },
    ],
  })
  const refusal = canonFindingsRefusal(decision.findings)
  for (const rule of ['canon/history', 'canon/issue', 'canon/date']) {
    expect(refusal).toContain(rule)
  }
})

test('a mixed canon refusal includes its numeral warning', () => {
  const refusal = canonFindingsRefusal([
    finding('canon/history', 'prose narrates history'),
    finding('canon/numeral', 'prose contains numeral 11', 2),
  ])
  expect(refusal).toContain('refusing canon write; introduced 1 finding')
  expect(refusal).toContain('warning:\nAGENTS.md:2 canon/numeral prose contains numeral 11')
})

test('reference writes require the explicit publisher marker for new and stored rows', () => {
  expect(referenceWriteRefusal({ requestedForm: 'reference' })).toContain(
    `${PLATFORM_SLUG} doc reference publish`,
  )
  expect(referenceWriteRefusal({ storedForm: 'reference' })).toContain(
    `${PLATFORM_SLUG} doc reference publish`,
  )
  expect(
    referenceWriteRefusal({
      storedForm: 'reference',
      requestedForm: 'reference',
      generator: REFERENCE_GENERATOR,
    }),
  ).toBeNull()
  expect(
    referenceWriteRefusal({
      requestedForm: 'overview',
      generator: REFERENCE_GENERATOR,
    }),
  ).toContain('generator marker is reserved for reference documents')
  expect(
    referenceWriteRefusal({
      storedForm: 'reference',
      requestedForm: 'overview',
      generator: REFERENCE_GENERATOR,
    }),
  ).toContain('generator marker is reserved for reference documents')
  expect(
    referenceWriteRefusal({
      storedForm: 'reference',
      requestedForm: null,
      generator: REFERENCE_GENERATOR,
    }),
  ).toContain('generator marker is reserved for reference documents')
  expect(
    referenceWriteRefusal({ storedForm: 'reference', generator: REFERENCE_GENERATOR }),
  ).toBeNull()
})

test('article fields require an article project and distinct subject attachments', () => {
  const valid = {
    scope: 'project',
    kind: 'article' as const,
    form: 'rule',
    ownSubjectId: 'own',
    relatedSubjectIds: ['related'],
    sourceFiles: ['src/rule.ts'],
  }
  expect(articleFieldRefusal(valid)).toBeNull()
  expect(articleFieldRefusal({ ...valid, scope: 'global' })).toContain('scope is project')
  expect(articleFieldRefusal({ ...valid, kind: 'working' })).toContain('kind is article')
  expect(articleFieldRefusal({ ...valid, relatedSubjectIds: ['related', 'related'] })).toBe(
    'related subjects must not contain duplicates',
  )
  expect(articleFieldRefusal({ ...valid, relatedSubjectIds: ['own'] })).toBe(
    'the article subject must not also be a related subject',
  )
})

test('articles are demand-only and excluded from canon', () => {
  const base = { scope: 'job', subject: 'understand', slug: 'guide', kind: 'article' as const }
  expect(refuseArticleDelivery({ ...base, delivery: 'inject' })).toContain(
    'kind article requires effective delivery demand',
  )
  expect(refuseArticleDelivery({ ...base, delivery: 'inject' })).toContain(
    `${PLATFORM_SLUG} doc set guide --scope job --subject understand --kind article --delivery demand`,
  )
  expect(refuseArticleDelivery({ ...base, delivery: 'demand' })).toBeNull()
  expect(
    refuseArticleDelivery({ ...base, scope: 'canon', subject: null, delivery: 'demand' }),
  ).toContain('canon scope requires kind working')
})

test('document writes derive their project from the shared scope subject kind', () => {
  const cases: [string, string | null, string | null][] = [
    ['project', 'alpha', 'alpha'],
    ['project', null, null],
    ['resume', 'alpha', 'alpha'],
    ['canon', 'alpha', 'alpha'],
    ['canon', null, null],
    ['settings', 'alpha', 'alpha'],
    ['settings', null, null],
    ['machine', null, null],
    ['global', null, null],
    ['agent', 'codex', null],
    ['job', 'understand', null],
    ['stack', 'typescript', null],
  ]
  for (const [scope, subject, expected] of cases) {
    expect(docWriteProjectName(scope, subject), scope).toBe(expected)
  }
})

test('project-address consistency accepts match and omission and refuses mismatch', () => {
  expect(refuseMismatchedDocProject('project', 'alpha', 'alpha')).toBeNull()
  expect(refuseMismatchedDocProject('project', 'alpha', undefined)).toBeNull()
  expect(refuseMismatchedDocProject('global', null, 'alpha')).toBeNull()
  expect(refuseMismatchedDocProject('project', 'alpha-two', 'alpha')).toBe(
    'document project "alpha" does not match address project "alpha-two"\n' +
      'cleared by: omit the project name, or correct the address',
  )
})

test('owned settings share the owner-private address rule with canon', () => {
  const owner = '01990000-0000-7000-8000-000000000091'
  expect(refuseOwnedDocAddress('settings', null, owner)).toBeNull()
  expect(refuseOwnedDocAddress('canon', null, owner)).toBeNull()
  expect(refuseOwnedDocAddress('settings', 'alpha', owner)).toContain('canon or settings')
  expect(refuseOwnedDocAddress('project', null, owner)).toContain('canon or settings')
  expect(refuseOwnedDocAddress('settings', null, null)).toBeNull()
  expect(refuseSettingsAddress('settings', null, owner)).toBeNull()
  expect(refuseSettingsAddress('settings', 'alpha', null)).toBeNull()
  expect(refuseSettingsAddress('settings', null, null)).toContain('owner and no subject')
  expect(refuseSettingsAddress('canon', null, null)).toBeNull()
})

test('canon removal refusal names the citer and remedy', () => {
  expect(
    canonRemovalRefusal([
      {
        file: 'workflow step verify',
        line: 4,
        rule: 'canon/reference-path',
        message: 'repository path .agents/reference/target.md is not tracked',
      },
    ]),
  ).toBe(
    'refusing canon removal; introduced 1 reference finding:\n' +
      'workflow step verify:4 canon/reference-path repository path .agents/reference/target.md is not tracked\n' +
      'cleared by: update or remove the named citations first, then retry the removal',
  )
})

const rule = {
  slug: '.agents/rules/10-code.md',
  body: '---\ndescription: Code\nalways: true\n---\n\nCite `architecture.ts`.\n',
}

describe('refuseCanonWrite tree facts', () => {
  test('accepts a repository path citation when tree facts are absent, and refuses when they are supplied without the path', () => {
    expect(
      refuseCanonWrite({
        current: [],
        next: [rule],
      }),
    ).toBeNull()
    expect(
      refuseCanonWrite({
        current: [],
        next: [rule],
        trackedPaths: [],
        packageScripts: [],
        sourceTexts: [],
      }),
    ).toContain('repository path architecture.ts is not tracked')
  })

  test('still refuses a writing rule when tree facts are absent', () => {
    expect(
      refuseCanonWrite({
        current: [],
        next: [
          {
            slug: '.agents/rules/10-code.md',
            body: '---\ndescription: Code\nalways: true\n---\n\nIt used to be different.\n',
          },
        ],
      }),
    ).toContain('canon/history')
  })
})

describe('globalCanonWriteTargets', () => {
  const candidate = (name: string, managedContext?: boolean) => ({
    name,
    path: `/w/${name}`,
    settings: { managedContext },
  })

  test('selects only projects opted into managed context', () => {
    const managed = candidate('managed', true)
    expect(globalCanonWriteTargets([candidate('unmanaged'), managed])).toEqual([managed])
  })

  test('falls back to checking global rows alone when no project is opted in', () => {
    expect(globalCanonWriteTargets([candidate('unmanaged', false)])).toEqual([null])
    expect(globalCanonWriteTargets([])).toEqual([null])
  })

  test('user writes select every managed project or the user set alone', () => {
    const managed = candidate('managed', true)
    expect(userCanonWriteTargets([candidate('unmanaged'), managed])).toEqual([managed])
    expect(userCanonWriteTargets([])).toEqual([null])
  })
})

const revisionOperations = ['create', 'set', undefined] as const
const revisionRows = ['present', 'absent'] as const
const revisionExpectations = ['none', 'matching', 'stale'] as const
const guardedRevisionScopes = new Set(['canon', 'settings', 'context'])

function matrixExpectedRevision(
  row: (typeof revisionRows)[number],
  expectation: (typeof revisionExpectations)[number],
): string | undefined {
  if (expectation === 'none' || (expectation === 'matching' && row === 'absent')) return undefined
  return expectation === 'matching' ? 'revision-2' : 'revision-1'
}

function matrixExpectedAllow(
  scope: string,
  op: (typeof revisionOperations)[number],
  row: (typeof revisionRows)[number],
  expectation: (typeof revisionExpectations)[number],
): boolean {
  if (op === 'create' && row === 'present') return false
  if (expectation === 'stale') return false
  return !(row === 'present' && expectation === 'none' && guardedRevisionScopes.has(scope))
}

const revisionMatrix = DOC_SCOPES.flatMap((scope) =>
  revisionOperations.flatMap((op) =>
    revisionRows.flatMap((row) =>
      revisionExpectations.map((expectation) => ({ scope, op, row, expectation })),
    ),
  ),
)

describe('decideDocRevisionWrite', () => {
  const address = { subject: null, slug: 'revision-test' }

  test('pins every scope, requested op, row state, and expected revision state', () => {
    for (const { scope, op, row, expectation } of revisionMatrix) {
      const decision = decideDocRevisionWrite({
        current: row === 'present' ? 'revision-2' : null,
        expected: matrixExpectedRevision(row, expectation),
        isCreate: row === 'absent',
        op,
        scope,
        subject: 'subject',
        slug: 'slug',
      })
      expect(decision.allow, `${scope}/${op ?? 'implicit'}/${row}/${expectation}`).toBe(
        matrixExpectedAllow(scope, op, row, expectation),
      )
    }
  })

  test('requires the current revision for an existing canon doc', () => {
    expect(
      decideDocRevisionWrite({
        current: 'revision-2',
        isCreate: false,
        scope: 'canon',
        ...address,
      }),
    ).toEqual({
      allow: false,
      refusal: {
        condition: 'refusing canon update at current revision revision-2',
        remedy: {
          kind: 'edit',
          text: `re-read the doc, then re-apply the edit with ${PLATFORM_SLUG} doc set revision-test --scope canon --expect revision-2`,
        },
      },
    })
    expect(
      decideDocRevisionWrite({
        expected: 'revision-2',
        current: 'revision-2',
        isCreate: false,
        scope: 'canon',
        ...address,
      }),
    ).toEqual({ allow: true })
  })

  test('requires the current revision for an existing settings doc', () => {
    expect(
      decideDocRevisionWrite({
        current: 'revision-2',
        isCreate: false,
        scope: 'settings',
        ...address,
      }),
    ).toEqual({
      allow: false,
      refusal: {
        condition: 'refusing settings update at current revision revision-2',
        remedy: {
          kind: 'edit',
          text: `read the settings, then write them with ${PLATFORM_SLUG} machine settings import --user`,
        },
      },
    })
  })

  test('context removals name the removal verb that reached the revision refusal', () => {
    const holder = 'task:01a1bf5e-5ce3-74de-9fc5-0698c26b4d91'
    const cases = [
      {
        op: 'delete' as const,
        contextDropTarget: undefined,
        remedy: `${PLATFORM_SLUG} doc rm approval --scope context --subject ${holder} --reason <text> --expect revision-2`,
      },
      {
        op: 'context-drop' as const,
        contextDropTarget: { kind: 'task' as const, value: 'DEV-2236' },
        remedy: `${PLATFORM_SLUG} agent context drop --task DEV-2236 --id approval --expected-revision revision-2`,
      },
    ]
    for (const { op, contextDropTarget, remedy } of cases) {
      const decision = decideDocRevisionWrite({
        current: 'revision-2',
        isCreate: false,
        op,
        contextDropTarget,
        scope: 'context',
        subject: holder,
        slug: 'approval',
      })
      expect(decision.allow).toBe(false)
      if (!decision.allow) expect(renderRefusal(decision.refusal)).toContain(remedy)
    }
  })

  test('refuses stale optional tokens in other scopes and tokens for a create', () => {
    expect(
      decideDocRevisionWrite({
        current: 'revision-2',
        isCreate: false,
        scope: 'global',
        ...address,
      }),
    ).toEqual({ allow: true })
    for (const input of [
      {
        expected: 'revision-1',
        current: 'revision-2',
        isCreate: false,
        scope: 'global',
        ...address,
      },
      {
        expected: 'revision-1',
        current: null,
        isCreate: true,
        scope: 'canon',
        ...address,
      },
    ]) {
      const decision = decideDocRevisionWrite(input)
      expect(decision.allow).toBe(false)
      if (!decision.allow) {
        const message = renderRefusal(decision.refusal)
        expect(message).toContain('expected revision revision-1')
        expect(message).toContain(`${PLATFORM_SLUG} doc set revision-test`)
      }
    }
  })

  test('allows creates without a token in every scope', () => {
    expect(
      decideDocRevisionWrite({ current: null, isCreate: true, scope: 'canon', ...address }),
    ).toEqual({ allow: true })
  })

  test("create collisions name each scope family's own write verb", () => {
    const cases = [
      {
        scope: 'project',
        subject: 'project-name',
        remedy: `${PLATFORM_SLUG} doc set revision-test --scope project --subject project-name --expect revision-2`,
      },
      {
        scope: 'context',
        subject: null,
        remedy: `${PLATFORM_SLUG} agent context set --id revision-test --expected-revision revision-2`,
      },
      {
        scope: 'settings',
        subject: null,
        remedy: `${PLATFORM_SLUG} machine settings import --user`,
      },
      {
        scope: 'settings',
        subject: 'project-name',
        remedy: `${PLATFORM_SLUG} machine settings import --project project-name`,
      },
    ]
    for (const { scope, subject, remedy } of cases) {
      const decision = decideDocRevisionWrite({
        current: 'revision-2',
        isCreate: false,
        op: 'create',
        scope,
        subject,
        slug: 'revision-test',
      })
      expect(decision.allow).toBe(false)
      if (!decision.allow) expect(renderRefusal(decision.refusal)).toContain(remedy)
    }
  })

  test('refuses a canon write or an explicit create on a row whose revision is absent', () => {
    for (const scope of DOC_SCOPES) {
      for (const op of revisionOperations) {
        const decision = decideDocRevisionWrite({
          current: null,
          isCreate: false,
          op,
          scope,
          ...address,
        })
        const refused = scope === 'canon' || op === 'create'
        if (!refused) {
          if (!decision.allow)
            expect(renderRefusal(decision.refusal)).not.toContain('--expect null')
          continue
        }
        expect(decision.allow, `${scope}/${op ?? 'implicit'}`).toBe(false)
        if (!decision.allow) {
          const message = renderRefusal(decision.refusal)
          expect(message).toContain(MISSING_HOSTED_REVISION_REMEDY)
          expect(message).not.toContain('--expect null')
        }
      }
    }
  })
})
