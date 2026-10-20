import type { Database } from 'bun:sqlite'

export function lensPortReferenceOrphanCounts(d: Database): string[] {
  const checks = [
    [
      'lens_revision.lens_record_id',
      'SELECT COUNT(*) n FROM lens_revision r WHERE NOT EXISTS (SELECT 1 FROM lens l WHERE l.id=r.lens_id AND l.space_id IS r.space_id)',
    ],
    [
      'lens_profile.lens_record_id',
      'SELECT COUNT(*) n FROM lens_profile p WHERE NOT EXISTS (SELECT 1 FROM lens l WHERE l.id=p.lens_id AND l.space_id IS p.space_id)',
    ],
    [
      'lens_profile_revision.profile_record_id',
      'SELECT COUNT(*) n FROM lens_profile_revision r WHERE NOT EXISTS (SELECT 1 FROM lens_profile p WHERE p.id=r.profile_id)',
    ],
    [
      'project_lens_profile.lens_record_id',
      'SELECT COUNT(*) n FROM project_lens_profile s WHERE s.lens_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lens l WHERE l.id=s.lens_id AND l.space_id IS s.space_id)',
    ],
    [
      'project_lens_profile_revision.selection_record_id',
      'SELECT COUNT(*) n FROM project_lens_profile_revision r WHERE NOT EXISTS (SELECT 1 FROM project_lens_profile s WHERE s.id=r.selection_id)',
    ],
    [
      'port_baseline.pair_record_id',
      'SELECT COUNT(*) n FROM port_baseline b WHERE NOT EXISTS (SELECT 1 FROM port_pair p WHERE p.id=b.pair_id)',
    ],
    [
      'port_skip.pair_record_id',
      'SELECT COUNT(*) n FROM port_skip s WHERE NOT EXISTS (SELECT 1 FROM port_pair p WHERE p.id=s.pair_id)',
    ],
    [
      'port_ref_source.ref_record_id',
      'SELECT COUNT(*) n FROM port_ref_source s WHERE NOT EXISTS (SELECT 1 FROM port_ref r WHERE r.target_project_record_id=s.target_project_record_id AND r.task_key=s.task_key AND r.space_id IS s.space_id)',
    ],
  ] as const
  return checks.flatMap(([label, sql]) => {
    const count = (d.query(sql).get() as { n: number }).n
    return count ? [`${label}=${count}`] : []
  })
}

export function portStaleCopyConflicts(d: Database): string[] {
  if (!d.query('SELECT 1 FROM record_install_binding WHERE id=1').get()) return []
  const checks = [
    [
      'port_pair',
      `SELECT l.record_id FROM port_pair l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM port_pair h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND l.source_project_record_id=h.source_project_record_id AND l.target_project_record_id=h.target_project_record_id AND l.created_at=h.created_at) ORDER BY l.record_id`,
    ],
    [
      'port_baseline',
      `SELECT l.record_id FROM port_baseline l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM port_baseline h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND l.source_commit IS h.source_commit AND (l.scanned_at IS h.scanned_at OR (length(l.scanned_at)=10 AND l.scanned_at||'T00:00:00.000Z'=h.scanned_at)) AND l.version=h.version) ORDER BY l.record_id`,
    ],
    [
      'port_doctrine',
      `SELECT l.record_id FROM port_doctrine l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM port_doctrine h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND l.number=h.number AND l.title=h.title AND l.body=h.body AND l.created_at=h.created_at AND l.retired_at IS h.retired_at AND l.version=h.version) ORDER BY l.record_id`,
    ],
    [
      'port_ref',
      `SELECT l.record_id FROM port_ref l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM port_ref h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND l.task_key=h.task_key AND l.target_project_record_id=h.target_project_record_id AND l.note=h.note AND l.created_at=h.created_at AND l.resolved_at IS h.resolved_at AND l.version=h.version) ORDER BY l.record_id`,
    ],
    [
      'port_ref_source',
      `SELECT l.record_id FROM port_ref_source l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM port_ref_source h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND l.task_key=h.task_key AND l.target_project_record_id=h.target_project_record_id AND l.source_project_record_id=h.source_project_record_id AND l.commits=h.commits AND l.paths=h.paths AND l.note=h.note) ORDER BY l.record_id`,
    ],
    [
      'port_skip',
      `SELECT l.record_id FROM port_skip l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM port_skip h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND l.candidate=h.candidate AND l.reason=h.reason AND l.skipped_at=h.skipped_at AND EXISTS (SELECT 1 FROM port_pair lp JOIN port_pair hp ON hp.record_id=lp.record_id AND hp.space_id IS NOT NULL WHERE lp.id=l.pair_id AND hp.id=h.pair_id)) ORDER BY l.record_id`,
    ],
  ] as const
  const conflicts: string[] = []
  for (const [table, sql] of checks) {
    const rows = d.query<{ record_id: string }, []>(sql).all()
    conflicts.push(...rows.map((row) => `${table}:${row.record_id}`))
  }
  return conflicts
}
