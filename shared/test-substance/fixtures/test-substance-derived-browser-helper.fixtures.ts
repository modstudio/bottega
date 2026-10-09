import { test as base } from '@playwright/test'

function authTest() {
  return base.extend({})
}

export const businessTest = authTest()
