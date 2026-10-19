import { expect, test } from 'bun:test'
import {
  HUB_DATA_PACKAGE,
  HUB_SITE_PACKAGE,
  HUB_UI_PACKAGE,
  HUB_VIEWS_PACKAGE,
  hubSiteArchitectureRules,
  hubUtilArchitectureRules,
  hubUtilRuntimeDependencyViolations,
  hubWebSourcePlacementViolation,
} from './architecture-hub-packages.ts'

test('hub web source placement allows routes and refuses presentation elsewhere', () => {
  expect(hubWebSourcePlacementViolation('hub/web/src/routes/settings/profile.tsx')).toBeNull()
  expect(hubWebSourcePlacementViolation('hub/web/src/components/profile.tsx')).toBe(
    `hub/web/src/components/profile.tsx: presentation belongs in ${HUB_UI_PACKAGE}, ${HUB_VIEWS_PACKAGE} or ${HUB_SITE_PACKAGE}, and data in ${HUB_DATA_PACKAGE}`,
  )
})

const utilRule = hubUtilArchitectureRules()[0]
const siteRule = hubSiteArchitectureRules((target) => `node_modules/${target}`)[0]

function utilImportIsAllowed(target: string) {
  return utilRule.to.pathNot.some((pattern) => new RegExp(pattern).test(target))
}

function siteImportIsAllowed(target: string) {
  return siteRule.to.pathNot.some((pattern) => new RegExp(pattern).test(target))
}

test('hub site imports only React, its own modules, and shared modules', () => {
  expect(siteImportIsAllowed('hub/site/src/navigation.tsx')).toBeTrue()
  expect(siteImportIsAllowed('shared/brand.ts')).toBeTrue()
  expect(siteImportIsAllowed('node_modules/react/index.js')).toBeTrue()
  expect(siteImportIsAllowed('node_modules/@tanstack/react-router/dist/esm/index.js')).toBeFalse()
  expect(siteImportIsAllowed('hub/ui/src/button/button.tsx')).toBeFalse()
})

test('hub util imports only its own modules and shared modules', () => {
  expect(utilImportIsAllowed('hub/util/src/format.ts')).toBeTrue()
  expect(utilImportIsAllowed('shared/brand.ts')).toBeTrue()
  expect(utilImportIsAllowed('@codemirror/view')).toBeFalse()
  expect(utilImportIsAllowed('node:fs')).toBeFalse()
})

test('hub util refuses declared runtime dependencies', () => {
  expect(hubUtilRuntimeDependencyViolations({ dependencies: { zod: '^4.0.0' } })).toContain(
    'hub/util/package.json: dependencies may not declare zod',
  )
  expect(
    hubUtilRuntimeDependencyViolations({
      peerDependencies: { react: '^19.0.0' },
      dependencies: undefined,
    }),
  ).toContain('hub/util/package.json: peerDependencies may not declare react')
  expect(hubUtilRuntimeDependencyViolations({})).toEqual([])
})
