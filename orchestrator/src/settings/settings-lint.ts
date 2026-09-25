// concern: settings-lint
/** Pure lint of owned Claude permission rules. Must not know filesystems, stores, commands, or transports. */
import type { Finding } from '../../../shared/ratchet.ts'
import {
  allPermissionRules,
  type OwnedSettings,
  type PermissionList,
  permissionLists,
} from './settings.ts'

export type SettingsTarget = { id: string; settings: OwnedSettings }

const BIN_PREFIXES = [
  ['./bin/orch', 'orch'],
  ['./bin/hub', 'hub'],
] as const

export function lintSettings(targets: SettingsTarget[]): Finding[] {
  const findings: Finding[] = []
  for (const target of targets) {
    findings.push(...lintWithin(target))
    findings.push(...lintBinPrefix(target))
    findings.push(...lintAllowDeny(target))
  }
  findings.push(...lintAcross(targets))
  return findings.sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line,
  )
}

function lintWithin(target: SettingsTarget): Finding[] {
  const seen = new Map<string, number>()
  const findings: Finding[] = []
  for (const rule of allPermissionRules(target.settings.permissions)) {
    const count = (seen.get(rule) ?? 0) + 1
    seen.set(rule, count)
    if (count === 2) {
      findings.push({
        file: target.id,
        line: 1,
        rule: 'settings/duplicate-within',
        message: `rule duplicated within ${target.id}: ${rule}`,
      })
    }
  }
  return findings
}

function lintAcross(targets: SettingsTarget[]): Finding[] {
  const user = targets.find((target) => target.id === 'user')
  if (!user) return []
  const userRules = new Set(allPermissionRules(user.settings.permissions))
  const findings: Finding[] = []
  const reported = new Set<string>()
  for (const target of targets) {
    if (target.id === 'user') continue
    for (const rule of allPermissionRules(target.settings.permissions)) {
      if (!userRules.has(rule)) continue
      const key = `${target.id}\0${rule}`
      if (reported.has(key)) continue
      reported.add(key)
      findings.push({
        file: target.id,
        line: 1,
        rule: 'settings/duplicate-across',
        message: `rule duplicated between user and ${target.id}: ${rule}`,
      })
    }
  }
  return findings
}

function lintBinPrefix(target: SettingsTarget): Finding[] {
  const rules = allPermissionRules(target.settings.permissions)
  const findings: Finding[] = []
  const reported = new Set<string>()
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const left = rules[i]!
      const right = rules[j]!
      if (left === right || stripBinPrefix(left) !== stripBinPrefix(right)) continue
      const key = [left, right].sort().join('\0')
      if (reported.has(key)) continue
      reported.add(key)
      findings.push({
        file: target.id,
        line: 1,
        rule: 'settings/bin-prefix',
        message: `rules differ only by ./bin prefix in ${target.id}: ${left} / ${right}`,
      })
    }
  }
  return findings
}

function lintAllowDeny(target: SettingsTarget): Finding[] {
  const lists = permissionLists(target.settings.permissions)
  const deny = new Set(lists.deny)
  const findings: Finding[] = []
  const reported = new Set<string>()
  for (const rule of lists.allow) {
    if (!deny.has(rule) || reported.has(rule)) continue
    reported.add(rule)
    findings.push({
      file: target.id,
      line: 1,
      rule: 'settings/allow-deny',
      message: `rule appears in both allow and deny in ${target.id}: ${rule}`,
    })
  }
  return findings
}

function stripBinPrefix(rule: string): string {
  let next = rule
  for (const [from, to] of BIN_PREFIXES) next = next.replaceAll(from, to)
  return next
}

export function adoptionCandidates(
  local: Record<PermissionList, string[]>,
  store: Record<PermissionList, string[]>,
): Record<PermissionList, { rule: string; inStore: boolean }[]> {
  return Object.fromEntries(
    (['allow', 'ask', 'deny'] as const).map((name) => [
      name,
      local[name].map((rule) => ({ rule, inStore: store[name].includes(rule) })),
    ]),
  ) as Record<PermissionList, { rule: string; inStore: boolean }[]>
}
