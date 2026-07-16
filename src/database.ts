import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { ConversationNode, JobRow } from "./types.ts";

export class Store {
  readonly db: Database;
  constructor(private config: Config) {
    mkdirSync(config.DATA_DIR, { recursive: true });
    this.db = new Database(join(config.DATA_DIR, "bot.sqlite"), { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        lease_owner TEXT,
        placeholder_message_id INTEGER,
        result TEXT,
        conversation_node_id INTEGER REFERENCES conversation_nodes(id) ON DELETE SET NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS conversation_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        input_message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        parent_node_id INTEGER REFERENCES conversation_nodes(id),
        question TEXT NOT NULL,
        quoted_text TEXT,
        answer TEXT NOT NULL,
        sources_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_messages (
        chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL REFERENCES conversation_nodes(id) ON DELETE CASCADE,
        PRIMARY KEY(chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS media_assets (
        hash TEXT PRIMARY KEY, path TEXT NOT NULL, mime_type TEXT NOT NULL,
        bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_media (
        node_id INTEGER NOT NULL REFERENCES conversation_nodes(id) ON DELETE CASCADE,
        media_hash TEXT NOT NULL REFERENCES media_assets(hash) ON DELETE CASCADE,
        priority INTEGER NOT NULL, PRIMARY KEY(node_id, media_hash)
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_outputs (
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY(job_id, kind, position)
      );
      CREATE TABLE IF NOT EXISTS pending_albums (
        group_id TEXT PRIMARY KEY,
        updates_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const jobColumns = this.db.query("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "lease_owner")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN lease_owner TEXT");
    }
    if (!jobColumns.some((column) => column.name === "result")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN result TEXT");
    }
    if (!jobColumns.some((column) => column.name === "conversation_node_id")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN conversation_node_id INTEGER REFERENCES conversation_nodes(id) ON DELETE SET NULL");
    }
  }

  acquireInstanceLease(owner: string, ttlMs: number): boolean {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db.query("SELECT value,updated_at FROM runtime_state WHERE key='instance-lease'").get() as { value: string; updated_at: number } | null;
      if (row && row.value !== owner && row.updated_at > now - ttlMs) return false;
      this.db.query(`INSERT INTO runtime_state(key,value,updated_at) VALUES('instance-lease',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(owner, now);
      return true;
    });
    return tx.immediate() as unknown as boolean;
  }

  renewInstanceLease(owner: string): boolean {
    return this.db.query("UPDATE runtime_state SET updated_at=? WHERE key='instance-lease' AND value=?")
      .run(Date.now(), owner).changes === 1;
  }

  releaseInstanceLease(owner: string) {
    this.db.query("DELETE FROM runtime_state WHERE key='instance-lease' AND value=?").run(owner);
  }

  enqueue(updateId: number, userId: number, chatId: number, payload: string): "queued" | "duplicate" | "full" | "busy" {
    const tx = this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM telegram_updates WHERE update_id=?").get(updateId)) return "duplicate" as const;
      const count = this.db.query("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number };
      if (count.n >= this.config.QUEUE_LIMIT) return "full" as const;
      if (this.db.query("SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running') LIMIT 1").get(userId)) return "busy" as const;
      const now = Date.now();
      this.db.query("INSERT INTO telegram_updates VALUES (?,?)").run(updateId, now);
      this.db.query(`INSERT INTO jobs(update_id,user_id,chat_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(updateId, userId, chatId, payload, now, now);
      return "queued" as const;
    });
    return tx.immediate() as unknown as "queued" | "duplicate" | "full" | "busy";
  }

  appendAlbumUpdate(groupId: string, updateJson: string) {
    const tx = this.db.transaction(() => {
      const row = this.db.query("SELECT updates_json FROM pending_albums WHERE group_id=?").get(groupId) as { updates_json: string } | null;
      const updates = row ? JSON.parse(row.updates_json) as unknown[] : [];
      const update = JSON.parse(updateJson) as { update_id?: unknown };
      if (typeof update.update_id !== "number" || !updates.some((item) => (item as { update_id?: unknown }).update_id === update.update_id)) updates.push(update);
      this.db.query(`INSERT INTO pending_albums(group_id,updates_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET updates_json=excluded.updates_json,updated_at=excluded.updated_at`)
        .run(groupId, JSON.stringify(updates), Date.now());
    });
    tx.immediate();
  }

  albumSnapshot(groupId: string): { updates: unknown[]; raw: string } | null {
    const row = this.db.query("SELECT updates_json FROM pending_albums WHERE group_id=?").get(groupId) as { updates_json: string } | null;
    return row ? { updates:JSON.parse(row.updates_json) as unknown[], raw:row.updates_json } : null;
  }

  pendingAlbumIds(): string[] {
    return (this.db.query("SELECT group_id FROM pending_albums ORDER BY updated_at").all() as Array<{ group_id: string }>).map((row) => row.group_id);
  }

  deleteAlbum(groupId: string, expectedRaw?: string) {
    if (expectedRaw === undefined) this.db.query("DELETE FROM pending_albums WHERE group_id=?").run(groupId);
    else this.db.query("DELETE FROM pending_albums WHERE group_id=? AND updates_json=?").run(groupId, expectedRaw);
  }

  claim(owner: string): JobRow | null {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      this.db.query("UPDATE jobs SET status='queued', lease_until=NULL, lease_owner=NULL WHERE status='running' AND lease_until < ?").run(now);
      const row = this.db.query("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as JobRow | null;
      if (!row) return null;
      this.db.query("UPDATE jobs SET status='running', attempts=attempts+1, lease_until=?, lease_owner=?, updated_at=? WHERE id=?")
        .run(now + this.config.QUERY_TIMEOUT_MS + 30_000, owner, now, row.id);
      return { ...row, status: "running", attempts: row.attempts + 1, lease_owner: owner } as JobRow;
    });
    return tx.immediate() as unknown as JobRow | null;
  }

  renewJobLease(id: number, owner: string): boolean {
    return this.db.query("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=?")
      .run(Date.now() + this.config.QUERY_TIMEOUT_MS + 30_000, Date.now(), id, owner).changes === 1;
  }
  setPlaceholder(id: number, owner: string, messageId: number) {
    this.db.query("UPDATE jobs SET placeholder_message_id=?,updated_at=? WHERE id=? AND lease_owner=?").run(messageId, Date.now(), id, owner);
  }
  setJobResult(id: number, owner: string, result: string): boolean {
    return this.db.query("UPDATE jobs SET result=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=?")
      .run(result, Date.now(), id, owner).changes === 1;
  }
  jobOutputs(id: number): Array<{ kind: string; position: number; message_id: number }> {
    return this.db.query("SELECT kind,position,message_id FROM job_outputs WHERE job_id=? ORDER BY kind,position").all(id) as Array<{ kind: string; position: number; message_id: number }>;
  }
  recordJobOutput(id: number, owner: string, kind: string, position: number, messageId: number): boolean {
    const tx = this.db.transaction(() => {
      if (!this.db.query("SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_owner=?").get(id, owner)) return false;
      this.db.query("INSERT OR IGNORE INTO job_outputs VALUES(?,?,?,?)").run(id, kind, position, messageId);
      return true;
    });
    return tx.immediate() as unknown as boolean;
  }
  complete(id: number, owner: string): boolean {
    return this.db.query("UPDATE jobs SET status='succeeded',payload='{}',result=NULL,lease_until=NULL,lease_owner=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=?")
      .run(Date.now(), id, owner).changes === 1;
  }
  fail(id: number, owner: string, error: string, retry: boolean): boolean {
    return this.db.query("UPDATE jobs SET status=?,payload=CASE WHEN ? THEN payload ELSE '{}' END,result=CASE WHEN ? THEN result ELSE NULL END,error=?,lease_until=NULL,lease_owner=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=?")
      .run(retry ? "queued" : "failed", retry ? 1 : 0, retry ? 1 : 0, error.slice(0, 1000), Date.now(), id, owner).changes === 1;
  }
  parentForMessage(chatId: number, messageId: number): ConversationNode | null {
    return this.db.query(`SELECT n.* FROM bot_messages b JOIN conversation_nodes n ON n.id=b.node_id
      WHERE b.chat_id=? AND b.message_id=? AND n.expires_at>?`).get(chatId, messageId, Date.now()) as ConversationNode | null;
  }
  conversationPath(parentId: number, ownerUserId?: number): ConversationNode[] {
    const rows: ConversationNode[] = [];
    let id: number | null = parentId;
    while (id && rows.length < this.config.CONTEXT_MAX_TURNS) {
      const row = this.db.query("SELECT * FROM conversation_nodes WHERE id=? AND expires_at>?").get(id, Date.now()) as ConversationNode | null;
      if (!row) break;
      if (ownerUserId !== undefined && row.user_id !== ownerUserId) break;
      rows.push(row); id = row.parent_node_id;
    }
    return rows.reverse();
  }
  addConversation(args: { jobId: number; owner: string; chatId: number; inputMessageId: number; userId: number; parentId?: number; question: string; quotedText?: string; answer: string; sources: string[]; outputIds: number[]; media: Array<{hash:string;path:string;mimeType:string;bytes:number}> }) {
    const tx = this.db.transaction(() => {
      if (!this.db.query("SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_owner=?").get(args.jobId, args.owner)) {
        throw new Error("job lease was lost before conversation commit");
      }
      const now = Date.now(), expires = now + this.config.CONTEXT_TTL_HOURS * 3_600_000;
      const result = this.db.query(`INSERT INTO conversation_nodes(chat_id,input_message_id,user_id,parent_node_id,question,quoted_text,answer,sources_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(args.chatId,args.inputMessageId,args.userId,args.parentId ?? null,args.question,args.quotedText ?? null,args.answer,JSON.stringify(args.sources),now,expires);
      const nodeId = Number(result.lastInsertRowid);
      for (const id of args.outputIds) this.db.query("INSERT OR IGNORE INTO bot_messages VALUES(?,?,?)").run(args.chatId,id,nodeId);
      args.media.forEach((m, i) => {
        this.db.query(`INSERT INTO media_assets(hash,path,mime_type,bytes,expires_at) VALUES(?,?,?,?,?)
          ON CONFLICT(hash) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)`).run(m.hash,m.path,m.mimeType,m.bytes,expires);
        this.db.query("INSERT OR IGNORE INTO node_media VALUES(?,?,?)").run(nodeId,m.hash,i);
      });
      this.db.query("UPDATE jobs SET conversation_node_id=?,updated_at=? WHERE id=? AND lease_owner=?")
        .run(nodeId, Date.now(), args.jobId, args.owner);
      return nodeId;
    });
    return tx.immediate();
  }
  recentMedia(parentId: number, limit: number, ownerUserId?: number): Array<{hash:string;path:string;mime_type:string;bytes:number}> {
    const path = this.conversationPath(parentId, ownerUserId).reverse();
    const out: Array<{hash:string;path:string;mime_type:string;bytes:number}> = [];
    for (const node of path) {
      const found = this.db.query(`SELECT a.* FROM node_media nm JOIN media_assets a ON a.hash=nm.media_hash WHERE nm.node_id=? AND a.expires_at>? ORDER BY nm.priority`).all(node.id, Date.now()) as typeof out;
      for (const item of found) if (!out.some(x => x.hash === item.hash)) out.push(item);
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }
  heartbeat(key: string, value = "ok") {
    this.db.query(`INSERT INTO runtime_state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,value,Date.now());
  }
  isMediaPathKnown(path: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM media_assets WHERE path=? LIMIT 1").get(path));
  }
  cleanup(): string[] {
    const expired = this.db.query("SELECT path FROM media_assets WHERE expires_at<=?").all(Date.now()) as Array<{path:string}>;
    const tx = this.db.transaction(() => {
      this.db.query(`DELETE FROM conversation_nodes AS n WHERE n.expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM conversation_nodes c WHERE c.parent_node_id=n.id AND c.expires_at>?)`).run(Date.now(), Date.now());
      this.db.query("DELETE FROM media_assets WHERE expires_at<=?").run(Date.now());
      this.db.query("DELETE FROM telegram_updates WHERE received_at<?").run(Date.now() - 7 * 86_400_000);
      this.db.query("DELETE FROM jobs WHERE status IN ('succeeded','failed') AND updated_at<?")
        .run(Date.now() - this.config.JOB_RETENTION_DAYS * 86_400_000);
      this.db.query("DELETE FROM pending_albums WHERE updated_at<?").run(Date.now() - 86_400_000);
    }); tx.immediate();
    return expired.map(x => x.path);
  }
  close() { this.db.close(); }
}
