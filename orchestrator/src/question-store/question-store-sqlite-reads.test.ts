import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { questionNumberProjectId } from './question-store-read.ts'

test('question number project lookup refuses numbers shared by projects', () => {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE run(record_id TEXT PRIMARY KEY, project_record_id TEXT);
    CREATE TABLE workflow_cursor(record_id TEXT PRIMARY KEY, project_record_id TEXT);
    CREATE TABLE question(
      record_id TEXT PRIMARY KEY,
      number INTEGER NOT NULL,
      run_record_id TEXT,
      workflow_cursor_record_id TEXT
    );
    INSERT INTO run VALUES ('run-a','project-a'),('run-b','project-b');
    INSERT INTO question VALUES ('question-a',7,'run-a',NULL),('question-b',7,'run-b',NULL);
  `)
  expect(() => questionNumberProjectId(database, 7)).toThrow(
    'question number 7 exists in more than one project; pass the question UUID, then retry',
  )
  database.close()
})
