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
  test('attributes methods by name, attribute, and multi-line signature, then leaves later code outside', async () => {
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
`,
      PHP_POLICY_RULES,
    )
    expect(report.findings.map(({ rule, testName }) => [rule, testName])).toEqual([
      ['createMock', 'testNamed'],
      ['tautology', 'attributed'],
      ['createMock', 'annotated'],
      ['no-assertions', 'testMultiLine'],
      ['mock-builder', OUTSIDE_TEST],
      ['vacuous-test', 'attributed'],
    ])
  })
})

describe('PHP vacuous methods', () => {
  test('flags type-only and constant-only methods but preserves the sole assertNotNull exception', async () => {
    const report = await findings(`
  public function testTypeOnly(): void {
    self::assertInstanceOf(Foo::class, $value);
    self::assertNotNull($value->id);
  }
  public function testConstantOnly(): void {
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
    ).toEqual(['testTypeOnly', 'testConstantOnly'])
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
