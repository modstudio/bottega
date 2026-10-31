import { readFileSync } from 'node:fs'
import { assetPath } from '../../shared/install-root.ts'
import { inspectionGitEnv } from '../../shared/git.ts'
import { projectOf, writeCommitKey } from './attribute.ts'
import { writeTransaction } from './db.ts'
import { projects } from './projects.ts'
import { createTask } from './task.ts'

export async function importTasks(file: string): Promise<number> {
  const checkout = assetPath()
  const project = projectOf(checkout)
  const prefix = projects().find((candidate) => candidate.name === project)?.settings
    .keyPrefixes?.[0]
  if (!project || !prefix) throw new Error('the local project must declare a key prefix')
  const items = JSON.parse(readFileSync(file, 'utf8')) as {
    title: string
    opened: string
    closed: string | null
    shas: string[]
  }[]
  const log = Bun.spawnSync(['git', '-C', checkout, 'log', '--all', '--format=%H%x09%cI'], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const stamps = new Map(
    new TextDecoder()
      .decode(log.stdout)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t') as [string, string]),
  )
  const imported: Array<{ key: string; shas: string[] }> = []
  for (const item of items) {
    const row = await createTask(
      {
        project,
        title: item.title,
        status: item.closed ? 'done' : 'open',
        openedAt: item.opened,
        closedAt: item.closed,
      },
      { skipDuplicateCheck: true },
    )
    imported.push({ key: row.key, shas: item.shas })
  }
  writeTransaction((conn) => {
    for (const item of imported)
      for (const sha of item.shas) {
        const at = stamps.get(sha)
        if (at) writeCommitKey(conn, { sha, repo: project, key: item.key, at })
      }
  })
  return items.length
}
