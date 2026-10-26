import { readFileSync } from 'node:fs'
import { assetPath } from '../../shared/install-root.ts'
import { projectOf } from './attribute.ts'
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
  const imported: Array<{ key: string; taskRecordId: string; shas: string[] }> = []
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
    imported.push({ key: row.key, taskRecordId: row.record_id, shas: item.shas })
  }
  writeTransaction((conn) => {
    for (const item of imported)
      for (const sha of item.shas) {
        const at = stamps.get(sha)
        if (at)
          conn
            .query(
              `INSERT OR IGNORE INTO commit_key (sha,repo,task_key,task_record_id,at)
               VALUES (?,?,?,?,?)`,
            )
            .run(sha, project, item.key, item.taskRecordId, at)
      }
  })
  return items.length
}
