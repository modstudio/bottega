import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../shared/config-directory.ts'
import { INSTALL_HOME_ENV } from '../../shared/install-root.ts'
import { hostedRequestHandler, hostedServerConfig } from './hosted.ts'
import { hostedRouter } from './trpc/hosted-router.ts'

describe('hosted server config', () => {
  test('resolves the record address from configured files in the supplied environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-record-api-'))
    try {
      const config = join(root, 'config')
      const harness = join(root, 'harness.env')
      mkdirSync(config)
      writeFileSync(harness, 'BOTTEGA_RECORD_API_URL=https://configured-record.example.test\n')

      expect(
        hostedServerConfig({
          [CONFIG_HOME_ENV]: config,
          [HARNESS_ENV_FILE_ENV]: harness,
          BOTTEGA_RECORD_DATABASE_URL: 'postgres://example.test/db',
        }).recordApiUrl,
      ).toBe('https://configured-record.example.test')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses to start without BOTTEGA_RECORD_API_URL', () => {
    expect(() =>
      hostedServerConfig({
        PORT: '3000',
        [CONFIG_HOME_ENV]: join(tmpdir(), 'missing-platform-test-config'),
        [HARNESS_ENV_FILE_ENV]: '',
      }),
    ).toThrow('BOTTEGA_RECORD_API_URL is required')
  })

  test('refuses to start without BOTTEGA_RECORD_DATABASE_URL', () => {
    expect(() =>
      hostedServerConfig({ BOTTEGA_RECORD_API_URL: 'https://api.example.test' }),
    ).toThrow('BOTTEGA_RECORD_DATABASE_URL is required')
  })

  test('defaults PORT to 3000', () => {
    expect(
      hostedServerConfig({
        BOTTEGA_RECORD_API_URL: 'https://api.example.test',
        BOTTEGA_RECORD_DATABASE_URL: 'postgres://example.test/db',
      }).port,
    ).toBe(3000)
  })
})

describe('hostedRouter', () => {
  test('hosted tRPC errors do not expose a stack', async () => {
    const response = await hostedRequestHandler({
      recordApiUrl: 'https://api.example.test',
      recordDatabaseUrl: {} as never,
    })(new Request('https://hub.example.test/trpc/notFound'))
    const body = (await response.json()) as { error: { data: Record<string, unknown> } }

    expect(response.status).toBe(404)
    expect(body.error.data).not.toHaveProperty('stack')
  })

  test('exposes the record and hosted context namespaces', () => {
    const procedures = Object.keys(hostedRouter._def.procedures).sort()
    expect(procedures).toEqual([
      'board.accept',
      'board.list',
      'board.post',
      'board.reply',
      'board.status',
      'board.thread',
      'board.withdraw',
      'context.autonomy.clearStage',
      'context.autonomy.get',
      'context.autonomy.set',
      'context.autonomy.setPreset',
      'context.autonomy.setRulings',
      'context.autonomy.setShipTo',
      'context.projects',
      'context.settings.get',
      'context.settings.permission',
      'context.userCanon.get',
      'context.userCanon.list',
      'context.userCanon.remove',
      'context.userCanon.set',
      'publicDocs.get',
      'publicDocs.search',
      'publicDocs.tree',
      'record.agents',
      'record.board',
      'record.configAccess',
      'record.createReportSubscription',
      'record.deleteDoc',
      'record.doc',
      'record.docRevisions',
      'record.docSearch',
      'record.docs',
      'record.done',
      'record.flight',
      'record.grantConfigAccess',
      'record.health',
      'record.jobs',
      'record.measurePeople',
      'record.measures',
      'record.notes',
      'record.projectReleases',
      'record.projects',
      'record.ratio',
      'record.removeReportSubscription',
      'record.reorderDocs',
      'record.review',
      'record.reviews',
      'record.routing',
      'record.run',
      'record.runsView',
      'record.saveDoc',
      'record.score',
      'record.sendReportSubscriptionTest',
      'record.setActiveSpace',
      'record.settings',
      'record.snapshots',
      'record.spend',
      'record.subjects',
      'record.task',
      'record.updateReportSubscription',
      'record.void',
      'record.whoami',
      'record.withdrawConfigAccess',
    ])
    expect(procedures).not.toContain('context.autonomy.setMachine')
    expect(procedures).not.toContain('context.autonomy.clearMachine')
    expect(procedures).not.toContain('context.settings.machinePermission')
  })
})

describe('hosted index', () => {
  test('adds public-doc discovery only to docs index responses and keeps HTML content types', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-docs-index-'))
    const previousInstallHome = process.env[INSTALL_HOME_ENV]
    try {
      const dist = join(root, 'hub/web/dist')
      mkdirSync(dist, { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
      writeFileSync(
        join(dist, 'index.html'),
        '<html><head></head><body><main>App</main></body></html>',
      )
      process.env[INSTALL_HOME_ENV] = root
      const handler = hostedRequestHandler(
        { recordApiUrl: 'https://api.example.test', recordDatabaseUrl: {} as never },
        {
          publicDocsText: {
            tree: async () => ({ items: [] }),
            doc: async () => ({ body: '' }),
          },
        },
      )

      const docs = await handler(
        new Request(`https://hub.example.test/docs/project/${PLATFORM_SLUG}/install`),
      )
      const docsHtml = await docs.text()
      expect(docs.headers.get('content-type')).toStartWith('text/html')
      expect(docsHtml).toContain('<body><noscript>')
      expect(docsHtml).toContain(
        `<head><link rel="alternate" type="text/markdown" href="/docs/project/${PLATFORM_SLUG}/install.md">`,
      )

      const home = await handler(new Request('https://hub.example.test/'))
      const homeHtml = await home.text()
      expect(home.headers.get('content-type')).toStartWith('text/html')
      expect(homeHtml).not.toContain('<noscript>')
      expect(homeHtml).not.toContain('rel="alternate"')
    } finally {
      if (previousInstallHome === undefined) delete process.env[INSTALL_HOME_ENV]
      else process.env[INSTALL_HOME_ENV] = previousInstallHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})
