import { expect, test } from 'bun:test'
import { judgeTestSubstance } from './test-substance-judge.ts'

test('judges an absolute test path outside the current checkout', async () => {
  expect(
    await judgeTestSubstance({
      file: '/another/project/example.test.ts',
      before: null,
      after: 'import { test } from "bun:test"\ntest("empty", () => {})\n',
    }),
  ).toMatchObject({
    status: 'refused',
    findings: [{ test: 'empty', rule: 'no-assertion' }],
  })
})

test('reports an unparseable test as unchecked', async () => {
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: null, after: 'broken' },
      async () => ({
        testSubstanceReport: async () => ({
          findings: [],
          parseError: 'could not parse test',
          runner: 'bun',
        }),
      }),
    ),
  ).toEqual({ status: 'unchecked', findings: [], reason: 'could not parse test' })
})

test('reports unavailable detectors as unchecked', async () => {
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: null, after: 'content' },
      async () => {
        throw new Error("Cannot find module 'eslint'")
      },
    ),
  ).toEqual({
    status: 'unchecked',
    findings: [],
    reason: "detectors unavailable in this build: Cannot find module 'eslint'",
  })
})

test('reports detector failures for proposed and prior content as unchecked', async () => {
  const failingAfter = async () => ({
    testSubstanceReport: async () => {
      throw new Error('lint exploded')
    },
  })
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: null, after: 'content' },
      failingAfter,
    ),
  ).toEqual({ status: 'unchecked', findings: [], reason: 'detector failed: lint exploded' })

  let calls = 0
  expect(
    await judgeTestSubstance(
      { file: 'example.test.ts', before: 'before', after: 'after' },
      async () => ({
        testSubstanceReport: async () => {
          calls += 1
          if (calls === 2) throw new Error('prior lint exploded')
          return { findings: [], runner: 'bun' }
        },
      }),
    ),
  ).toEqual({ status: 'unchecked', findings: [], reason: 'detector failed: prior lint exploded' })
})

test('judges only a newly added PHP vacuous method', async () => {
  const oldMethod = `public function testOld(): void { self::assertSame('old', 'value'); }`
  const before = `<?php class FooTest { ${oldMethod} }`
  const unchanged = await judgeTestSubstance({
    file: '/project/tests/Feature/FooTest.php',
    before,
    after: `${before}\n// unrelated edit`,
  })
  expect(unchanged).toEqual({ status: 'ok', findings: [], reason: '' })

  const added = await judgeTestSubstance({
    file: '/project/tests/Feature/FooTest.php',
    before,
    after: `<?php class FooTest { ${oldMethod} public function testAdded(): void { self::assertSame('new', 'value'); } }`,
  })
  expect(added).toMatchObject({
    status: 'refused',
    findings: [{ test: 'testAdded', rule: 'vacuous-test' }],
  })
})

test('enables PHP policy findings only when requested', async () => {
  const input = {
    file: '/project/tests/Feature/FooTest.php',
    before: null,
    after: `<?php class FooTest { public function testMock(): void { $this->createMock(Foo::class); } }`,
  }
  expect(await judgeTestSubstance(input)).toEqual({ status: 'ok', findings: [], reason: '' })
  expect(await judgeTestSubstance({ ...input, phpPolicyRules: ['createMock'] })).toMatchObject({
    status: 'refused',
    findings: [{ test: 'testMock', rule: 'createMock' }],
  })
})
