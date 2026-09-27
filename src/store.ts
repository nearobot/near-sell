import type { Settings, Target, TargetConfig, TargetStatus, Execution, Plan, FinishedStatus } from './types.ts';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { assert, validateTarget } from './core.ts';

export function acquireProcessLock(file: string) {
  const lock = new DatabaseSync(file);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch { lock.close(); assert(false, 'Another bot/import session is running. Stop it before continuing.'); }
  let released = false;
  return () => { if (!released) { released = true; lock.exec('ROLLBACK'); lock.close(); } };
}

export class Store {
  db: DatabaseSync;
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wallets (account TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, status TEXT NOT NULL, account TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, account TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracked (account TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(account, token));`);
  }
  close() { this.db.close(); }
  setting<K extends keyof Settings>(key: K): Settings[K] | null;
  setting<K extends keyof Settings>(key: K, fallback: Settings[K]): Settings[K];
  setting<K extends keyof Settings>(key: K, fallback: Settings[K] | null = null): Settings[K] | null { const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(String(r.value)) as Settings[K] : fallback; }
  set<K extends keyof Settings>(key: K, value: Settings[K]) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  addWallet(account: string) { this.db.prepare('INSERT OR IGNORE INTO wallets VALUES (?)').run(account); }
  wallets() { return this.db.prepare('SELECT account FROM wallets ORDER BY account').all().map(x => String(x.account)); }
  track(account: string, token: string) { this.db.prepare('INSERT OR IGNORE INTO tracked VALUES (?,?)').run(account, token); }
  tracked(account: string) { return this.db.prepare('SELECT token FROM tracked WHERE account=?').all(account).map(x => String(x.token)); }
  target(id: string): Target | null { const r = this.db.prepare('SELECT body FROM targets WHERE id=?').get(id); return r ? JSON.parse(String(r.body)) : null; }
  targets(): Target[] { return this.db.prepare('SELECT body FROM targets ORDER BY rowid DESC').all().map(x => JSON.parse(String(x.body))); }
  createTarget(input: TargetConfig & Pick<Target, 'tokenName' | 'tokenSymbol'>) {
    const t: Target = { ...validateTarget(input), id: crypto.randomBytes(6).toString('hex'), status: 'draft', createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 };
    this.db.prepare('INSERT INTO targets VALUES (?,?,?,?)').run(t.id, t.status, t.account, JSON.stringify(t)); return t;
  }
  change(id: string, allowed: TargetStatus[], changes: Partial<Target>) {
    const t = this.target(id); assert(t && allowed.includes(t.status), 'This target has changed. Refresh /targets.');
    const next = { ...t, ...changes, updatedAt: Date.now() };
    const result = this.db.prepare('UPDATE targets SET status=?, body=? WHERE id=? AND status=?').run(next.status, JSON.stringify(next), id, t.status);
    assert(result.changes === 1, 'Target was already updated.'); return next;
  }
  note(id: string, message: string) { const t = this.target(id); if (t) return this.change(id, [t.status], { lastError: message, lastCheckedAt: Date.now() }); }
  executions(): Execution[] { return this.db.prepare('SELECT body FROM executions ORDER BY rowid DESC').all().map(x => JSON.parse(String(x.body))); }
  execution(id: string): Execution | null { const r = this.db.prepare('SELECT body FROM executions WHERE id=?').get(id); return r ? JSON.parse(String(r.body)) : null; }
  pending(account: string) { return this.executions().some(e => e.account === account && ['preparing', 'signed', 'pending', 'uncertain', 'needs_review'].includes(e.status)); }
  begin(target: Target, plan: Plan) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assert(!this.pending(target.account), 'This wallet has an unresolved transaction. Use /reconcile.');
      const e: Execution = { id: crypto.randomBytes(8).toString('hex'), targetId: target.id, account: target.account, status: 'preparing', plan, createdAt: Date.now() };
      this.change(target.id, ['active'], { status: 'executing', executionId: e.id, lastError: null });
      this.db.prepare('INSERT INTO executions VALUES (?,?,?,?,?)').run(e.id, target.id, e.account, e.status, JSON.stringify(e));
      this.db.exec('COMMIT'); return e;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  updateExecution(id: string, changes: Partial<Execution>) {
    const e = this.execution(id); assert(e, 'Execution not found.'); Object.assign(e, changes, { updatedAt: Date.now() });
    this.db.prepare('UPDATE executions SET status=?,body=? WHERE id=?').run(e.status, JSON.stringify(e), id); return e;
  }
  finish(id: string, status: FinishedStatus, changes: Partial<Execution> = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const e = this.updateExecution(id, { ...changes, status });
      this.change(e.targetId, ['executing'], { status: status === 'registered' ? 'active' : status, lastError: changes.reason || null, finishedAt: Date.now() });
      this.db.exec('COMMIT'); return e;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recover() {
    for (const e of this.executions()) if (e.status === 'preparing') this.finish(e.id, 'paused', { reason: 'Restarted before signing. Review and resume this target.' });
  }
}
