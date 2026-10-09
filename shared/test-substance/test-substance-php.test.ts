import { describe, expect, test } from 'bun:test'
import { OUTSIDE_TEST, PHP_POLICY_RULES } from './test-substance'
import { phpTestSubstanceReport } from './test-substance-php'

const file = '/project/tests/Feature/FooTest.php'

async function findings(content: string) {
  return (
    await phpTestSubstanceReport(file, `<?php\nclass FooTest {\n${content}\n}`, PHP_POLICY_RULES)
  ).findings
}

describe('PHP test attribution', () => {
  test('attributes class and trait methods, then leaves later code outside', async () => {
    const report = await phpTestSubstanceReport(
      file,
      `<?php
class FooTest {
  public function testNamed(): void { $this->createMock(Foo::class); }
  #[Test]
  public function attributed(): void { self::assertTrue(true); }
  /** @test */
  public function annotated(): void { self::createMock(Foo::class); }
  public function testMultiLine(
    string $input,
  ): void { self::expectNotToPerformAssertions(); }
}
$this->getMockBuilder(Foo::class);
trait SharedTests {
  public function testFromTrait(): void { $this->createMock(Foo::class); }
}
`,
      PHP_POLICY_RULES,
    )
    expect(report.findings.map(({ rule, testName }) => [rule, testName])).toEqual([
      ['createMock', 'testNamed'],
      ['tautology', 'attributed'],
      ['createMock', 'annotated'],
      ['no-assertions', 'testMultiLine'],
      ['mock-builder', OUTSIDE_TEST],
      ['createMock', 'testFromTrait'],
      ['vacuous-test', 'attributed'],
    ])
  })
})

describe('PHP vacuous methods', () => {
  test('splits constant-only from policy type-only and preserves the sole assertNotNull exception', async () => {
    const report = await findings(`
  public function testTypeOnly(): void {
    self::assertInstanceOf(Foo::class, $value);
    self::assertNotNull($value->id);
  }
  public function testConstantOnly(): void {
    self::assertSame('a', 'b');
  }
  public function testTypeWithConstantNoise(): void {
    self::assertInstanceOf(Foo::class, $value);
    self::assertSame('a', 'b');
  }
  public function testExists(): void {
    self::assertNotNull(Foo::find($id));
  }
  public function testRealValue(): void {
    self::assertInstanceOf(Foo::class, $value);
    self::assertSame(42, $value->total());
  }
`)
    expect(
      report.filter(({ rule }) => rule === 'vacuous-test').map(({ testName }) => testName),
    ).toEqual(['testConstantOnly'])
    expect(
      report.filter(({ rule }) => rule === 'type-only-test').map(({ testName }) => testName),
    ).toEqual(['testTypeOnly', 'testTypeWithConstantNoise'])

    const universal = await phpTestSubstanceReport(
      file,
      `<?php class FooTest {
        public function testTypeOnly(): void {
          self::assertInstanceOf(Foo::class, $value);
        }
      }`,
      [],
    )
    expect(universal.findings).toEqual([])
  })

  test('treats fluent assertions, receiver expectations, and exception expectations as real', async () => {
    const report = await findings(`
  public function testPendingCommand(): void {
    $pendingCommand->expectsOutput('done')->assertSuccessful();
  }
  public function testCommandResult(): void {
    $this->check()->assertFailed();
  }
  public function testExpectations(): void {
    $mock->shouldReceive('run');
  }
  public function testStaticFluentAssertion(): void {
    Response::assertSuccessful();
  }
  public function testExpectedException(): void {
    $this->expectExceptionMessage('failure');
  }
`)
    expect(report.filter(({ rule }) => rule === 'vacuous-test')).toEqual([])
  })

  test('treats a project assertion helper with literal arguments as real', async () => {
    const report = await findings(`
  public function testPreviewStatus(): void {
    $this->assertPreviewStatus(422, ['word_cap' => 96]);
  }
`)
    expect(report.filter(({ rule }) => rule === 'vacuous-test')).toEqual([])
  })

  test('classifies PHPUnit assertions only through PHPUnit receivers', async () => {
    const report = await findings(`
  public function testAssertClass(): void {
    Assert::assertSame('a', 'b');
  }
  public function testNamespacedAssertClass(): void {
    \\PHPUnit\\Framework\\Assert::assertSame('a', 'b');
  }
  public function testThisScope(): void {
    $this::assertSame('a', 'b');
  }
  public function testObjectHelper(): void {
    $response->assertSame('a', 'b');
  }
`)
    expect(
      report.filter(({ rule }) => rule === 'vacuous-test').map(({ testName }) => testName),
    ).toEqual(['testAssertClass', 'testNamespacedAssertClass', 'testThisScope'])
  })
})

test('detects a query-builder assertion split after the object operator', async () => {
  const report = await findings(`
  public function testQuery(): void {
    $sql = $builder->
      toSql();
  }
`)
  expect(report).toContainEqual(
    expect.objectContaining({ rule: 'sql-string-matching', testName: 'testQuery', line: 6 }),
  )
})

test('keeps method and unterminated-signature scans within the hook budget', async () => {
  const maximumScanMilliseconds = 5_000
  const method = `public function testSmall(): void { self::assertSame('a', 'b'); }\n`
  const manyMethods = `<?php class LargeTest {\n${method.repeat(15_000)}}`
  const withoutBraces = `<?php class LargeTest {\npublic function testMissing(${`value, `.repeat(150_000)}`

  for (const [shape, content] of [
    ['many small methods', manyMethods],
    ['one unterminated signature', withoutBraces],
  ] as const) {
    const started = performance.now()
    await phpTestSubstanceReport(file, content, PHP_POLICY_RULES)
    expect(performance.now() - started, shape).toBeLessThan(maximumScanMilliseconds)
  }
})
