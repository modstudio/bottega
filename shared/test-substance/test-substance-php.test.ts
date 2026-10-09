import { describe, expect, test } from 'bun:test'
import { OUTSIDE_TEST } from './test-substance'
import { phpTestSubstanceReport } from './test-substance-php'

const file = '/project/tests/Feature/FooTest.php'

async function findings(content: string) {
  return (await phpTestSubstanceReport(file, `<?php\nclass FooTest {\n${content}\n}`)).findings
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
