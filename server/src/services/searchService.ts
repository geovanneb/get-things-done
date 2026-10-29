import * as path from 'path';
import * as fs from 'fs';
import { SearchResult } from '../types';
import { WorkspaceService } from './workspace';
import { FileService } from './fileService';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { ContextService } from './contextService';
import { OutputService } from './outputService';

const workspaceService = new WorkspaceService();
const fileService = new FileService();
const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const contextService = new ContextService();
const outputService = new OutputService();

interface FTSRow {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string | null;
  file_path: string | null;
  rank: number;
}

interface IndexRow {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string | null;
  path: string | null;
}

// The parts of node:sqlite used here. Declared locally because the @types/node line we use (20.x) predates it.
interface Statement {
  run(...params: (string | null)[]): unknown;
  all(...params: string[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type DatabaseCtor = new (path: string) => SqliteDatabase;

/**
 * The search index uses Node's built-in SQLite (node:sqlite, with FTS5): nothing native to install or rebuild,
 * and the desktop app's Node has it too. Node 22.13+ has it without a flag. On older Node versions, or if the
 * index cannot be opened, search falls back to an in-memory substring scan.
 */
let sqliteCtor: DatabaseCtor | null | undefined;

function loadSqlite(): DatabaseCtor | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily: older Node versions lack it
    sqliteCtor = (require('node:sqlite') as { DatabaseSync: DatabaseCtor }).DatabaseSync;
  } catch (err) {
    console.warn(
      '[search] node:sqlite unavailable (Node 22.13+ has it), falling back to in-memory search:',
      err instanceof Error ? err.message : err
    );
    sqliteCtor = null;
  }
  return sqliteCtor;
}

export class SearchService {
  private db: SqliteDatabase | null = null;
  private memoryRows: IndexRow[] | null = null;

  /** Drops the open index so the next query reopens it under the current workspace. */
  reset(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // already closed
      }
    }
    this.db = null;
    this.memoryRows = null;
  }

  private getDbPath(): string {
    return path.join(workspaceService.getWorkspacePath(), '.situation-board', 'cache', 'search.db');
  }

  /** Returns null when node:sqlite is unavailable or the DB cannot be opened. */
  private openDb(): SqliteDatabase | null {
    if (this.db) return this.db;

    const Ctor = loadSqlite();
    if (!Ctor) return null;

    try {
      const dbPath = this.getDbPath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new Ctor(dbPath);
      this.initSchema();
      return this.db;
    } catch (err) {
      console.warn(
        '[search] could not open search index, falling back to in-memory search:',
        err instanceof Error ? err.message : err
      );
      sqliteCtor = null;
      this.db = null;
      return null;
    }
  }

  private initSchema(): void {
    const db = this.db!;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        id UNINDEXED,
        type UNINDEXED,
        title,
        body,
        status UNINDEXED,
        file_path UNINDEXED
      );
    `);
  }

  /** Gathers every indexable entity. Each source is optional — a missing folder yields nothing. */
  private async collectRows(): Promise<IndexRow[]> {
    const rows: IndexRow[] = [];

    try {
      const tasks = await taskService.listTasks();
      for (const t of tasks) {
        rows.push({ id: t.id, type: 'task', title: t.title, body: [t.description, t.objective, t.body, t.tags.join(' ')].filter(Boolean).join(' '), status: t.status, path: t.path || null });
      }
    } catch { /* no tasks yet */ }

    try {
      const stakeholders = await stakeholderService.listStakeholders();
      for (const s of stakeholders) {
        rows.push({ id: s.id, type: 'stakeholder', title: s.name, body: [s.role, s.organization, s.what_matters, s.tags.join(' ')].filter(Boolean).join(' '), status: null, path: s.path || null });
      }
    } catch { /* no stakeholders yet */ }

    try {
      const notes = await contextService.listContextNotes();
      for (const n of notes) {
        rows.push({ id: n.id, type: 'context', title: n.title, body: [n.content, n.tags.join(' ')].filter(Boolean).join(' '), status: null, path: n.path || null });
      }
    } catch { /* no context yet */ }

    try {
      const templates = await outputService.listTemplates();
      for (const t of templates) {
        rows.push({ id: t.id, type: 'output', title: t.name, body: [t.description, t.tags.join(' ')].filter(Boolean).join(' '), status: null, path: t.path || null });
      }
    } catch { /* no outputs yet */ }

    return rows;
  }

  async buildIndex(): Promise<void> {
    const rows = await this.collectRows();
    const db = this.openDb();

    if (!db) {
      this.memoryRows = rows;
      return;
    }

    const insertStmt = db.prepare(
      'INSERT INTO entities_fts (id, type, title, body, status, file_path) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // One transaction: much faster than one write per row, and a failure leaves the old index intact.
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM entities_fts');
      for (const row of rows) {
        insertStmt.run(row.id, row.type, row.title, row.body, row.status, row.path);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Substring scan used when the SQLite search index is unavailable. */
  private async searchInMemory(query: string, types?: string[]): Promise<SearchResult[]> {
    if (!this.memoryRows) {
      this.memoryRows = await this.collectRows();
    }

    const needle = query.toLowerCase().trim();
    if (!needle) return [];

    const scored: { row: IndexRow; score: number }[] = [];

    for (const row of this.memoryRows) {
      if (types && types.length > 0 && !types.includes(row.type)) continue;

      const title = (row.title || '').toLowerCase();
      const body = (row.body || '').toLowerCase();

      // Title hits outrank body hits; an exact title match outranks both.
      let score = 0;
      if (title === needle) score = 3;
      else if (title.includes(needle)) score = 2;
      else if (body.includes(needle)) score = 1;

      if (score > 0) scored.push({ row, score });
    }

    scored.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title));

    return scored.slice(0, 50).map(({ row, score }) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      excerpt: this.makeExcerpt(row.body, query),
      status: row.status || undefined,
      path: row.path || undefined,
      relevance: score,
    }));
  }

  async search(query: string, types?: string[]): Promise<SearchResult[]> {
    const db = this.openDb();
    if (!db) return this.searchInMemory(query, types);

    // Escape FTS5 special characters
    const escapedQuery = query.replace(/["]/g, '""');

    let sql = `
      SELECT id, type, title, body, status, file_path, rank
      FROM entities_fts
      WHERE entities_fts MATCH ?
    `;

    const params: string[] = [`"${escapedQuery}"*`];

    if (types && types.length > 0) {
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ' ORDER BY rank LIMIT 50';

    let rows: FTSRow[];
    try {
      rows = db.prepare(sql).all(...params) as FTSRow[];
    } catch {
      // FTS query failed, try simple LIKE search
      rows = [];
    }

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      excerpt: this.makeExcerpt(row.body, query),
      status: row.status || undefined,
      path: row.file_path || undefined,
      relevance: Math.abs(row.rank),
    }));
  }

  async invalidateEntity(id: string): Promise<void> {
    const db = this.openDb();
    if (!db) {
      if (this.memoryRows) {
        this.memoryRows = this.memoryRows.filter((r) => r.id !== id);
      }
      return;
    }
    db.prepare('DELETE FROM entities_fts WHERE id = ?').run(id);
  }

  async indexEntity(entity: Record<string, unknown>, type: string): Promise<void> {
    const id = String(entity['id'] || '');
    const title = String(entity['title'] || entity['name'] || '');
    const body = [entity['description'], entity['content'], entity['objective'], (entity['tags'] as string[] || []).join(' ')].filter(Boolean).join(' ');
    const status = entity['status'] ? String(entity['status']) : null;
    const filePath = entity['path'] ? String(entity['path']) : null;

    const db = this.openDb();
    if (!db) {
      if (this.memoryRows) {
        this.memoryRows = this.memoryRows.filter((r) => r.id !== id);
        this.memoryRows.push({ id, type, title, body, status, path: filePath });
      }
      return;
    }

    db.prepare('DELETE FROM entities_fts WHERE id = ?').run(id);
    db.prepare('INSERT INTO entities_fts (id, type, title, body, status, file_path) VALUES (?, ?, ?, ?, ?, ?)').run(id, type, title, body, status, filePath);
  }

  private makeExcerpt(text: string, query: string, maxLen = 150): string {
    if (!text) return '';
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');

    const start = Math.max(0, idx - 50);
    const end = Math.min(text.length, idx + query.length + 100);
    const excerpt = text.slice(start, end);
    return (start > 0 ? '...' : '') + excerpt + (end < text.length ? '...' : '');
  }
}

export const searchService = new SearchService();
