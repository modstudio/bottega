<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Foundation\Testing\DatabaseTransactions;

final class SubstanceFixtureTest
{
    public function testCreateMock(): void
    {
        $this->createMock(Service::class);
    }

    public function testMockBuilder(): void
    {
        $this->getMockBuilder(Service::class);
    }

    public function testSelfEqual(): void
    {
        self::assertSame($expected, $expected);
        self::assertSame(42, $result->total());
    }

    public function testTautology(): void
    {
        self::assertTrue(true);
        self::assertSame(42, $result->total());
    }

    public function testSkipped(): void
    {
        self::markTestSkipped('fixture');
    }

    public function testNoAssertionsDeclaration(): void
    {
        self::expectNotToPerformAssertions();
    }

    public function testSqlMatching(): void
    {
        self::assertSame('select 1', $builder->toSql());
        $bindings = $builder->
            getBindings();
        self::assertSame([], $bindings);
    }

    #[Test]
    public function fixtureVacuousMethod(): void
    {
        self::assertInstanceOf(Service::class, $service);
    }

    // test-substance-allow: tautology deliberately covered elsewhere
    public function testWaivedSkip(): void
    {
        self::assertSame(42, $result->total());
    }

    // test-substance-allow: skipped covered by an external contract
    public function testCleanUsedWaiver(): void
    {
        self::markTestSkipped('covered elsewhere');
    }

    public function testCleanCreateStub(): void
    {
        $this->createStub(Service::class);
    }

    public function testCleanDistinctValues(): void
    {
        self::assertSame($expected, $actual);
    }

    public function testCleanBooleanEffect(): void
    {
        self::assertTrue($result->succeeded());
    }

    public function testCleanExecutedTest(): void
    {
        self::assertSame('done', $result->status());
    }

    public function testCleanAssertionsExpected(): void
    {
        self::assertSame(2, $result->count());
    }

    public function testCleanQueryResult(): void
    {
        self::assertSame([$expected], $query->get());
    }

    public function testCleanSoleNotNull(): void
    {
        self::assertNotNull(Carrier::find($id));
    }
}
