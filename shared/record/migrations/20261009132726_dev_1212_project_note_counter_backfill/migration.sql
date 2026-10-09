ALTER TABLE seq NO FORCE ROW LEVEL SECURITY;

INSERT INTO seq (space_id, project_id, name, next)
SELECT n.space_id, p.id, 'note', max(n.number) + 1
FROM hub_note n
JOIN project p ON p.space_id = n.space_id AND p.name = n.project_name
GROUP BY n.space_id, p.id
ON CONFLICT (space_id, project_id, name) DO UPDATE
SET next = greatest(seq.next, excluded.next);

ALTER TABLE seq FORCE ROW LEVEL SECURITY;
