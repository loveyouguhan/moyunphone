// src/db/worker/schema.ts
var CURRENT_SCHEMA_VERSION = 4;
var BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sys_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  physical_name TEXT NOT NULL UNIQUE,
  ddl TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('always', 'recall', 'manual')),
  row_template TEXT NOT NULL,
  token_budget INTEGER NOT NULL DEFAULT 256 CHECK (token_budget > 0),
  order_no INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  inject_condition TEXT NOT NULL DEFAULT '',
  fill_guide TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sheet_scope_order ON sheet(scope_id, order_no, name);

CREATE TABLE IF NOT EXISTS mem_doc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sheet_id TEXT,
  row_key TEXT,
  text TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0 CHECK (importance >= 0 AND importance <= 1),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  valid_from INTEGER,
  valid_to INTEGER,
  tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (sheet_id) REFERENCES sheet(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_doc_sheet_row
  ON mem_doc(scope_id, sheet_id, row_key)
  WHERE sheet_id IS NOT NULL AND row_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_doc_scope_updated ON mem_doc(scope_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_doc_scope_pinned ON mem_doc(scope_id, pinned DESC, importance DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS mem_vec (
  doc_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL CHECK (dim > 0),
  vec BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES mem_doc(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS op_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  sql TEXT NOT NULL,
  params TEXT NOT NULL,
  revision INTEGER NOT NULL,
  floor INTEGER NOT NULL DEFAULT -1,
  snapshot TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_log_scope_at ON op_log(scope_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_op_log_scope_floor ON op_log(scope_id, floor);
`;
function ensureFts5(db) {
  const existing = db.selectValue("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mem_fts'");
  if (existing === "mem_fts") return true;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
        text,
        content='mem_doc',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS mem_doc_ai AFTER INSERT ON mem_doc BEGIN
        INSERT INTO mem_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_doc_ad AFTER DELETE ON mem_doc BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_doc_au AFTER UPDATE OF text ON mem_doc BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO mem_fts(rowid, text) VALUES (new.id, new.text);
      END;
      INSERT INTO mem_fts(mem_fts) VALUES ('rebuild');
    `);
    return true;
  } catch {
    return false;
  }
}
function migrateV1(db) {
  db.exec(BASE_SCHEMA);
  return ensureFts5(db);
}
function migrateV2(db) {
  const hasFloor = db.selectValue("SELECT COUNT(*) FROM pragma_table_info('op_log') WHERE name = 'floor'");
  if (Number(hasFloor ?? 0) === 0) {
    db.exec("ALTER TABLE op_log ADD COLUMN floor INTEGER NOT NULL DEFAULT -1");
  }
  const hasSnapshot = db.selectValue("SELECT COUNT(*) FROM pragma_table_info('op_log') WHERE name = 'snapshot'");
  if (Number(hasSnapshot ?? 0) === 0) {
    db.exec("ALTER TABLE op_log ADD COLUMN snapshot TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_op_log_scope_floor ON op_log(scope_id, floor)");
}
function migrateV3(db) {
  const hasCondition = db.selectValue("SELECT COUNT(*) FROM pragma_table_info('sheet') WHERE name = 'inject_condition'");
  if (Number(hasCondition ?? 0) === 0) {
    db.exec("ALTER TABLE sheet ADD COLUMN inject_condition TEXT NOT NULL DEFAULT ''");
  }
}
function migrateV4(db) {
  const hasFillGuide = db.selectValue("SELECT COUNT(*) FROM pragma_table_info('sheet') WHERE name = 'fill_guide'");
  if (Number(hasFillGuide ?? 0) === 0) {
    db.exec("ALTER TABLE sheet ADD COLUMN fill_guide TEXT NOT NULL DEFAULT ''");
  }
}
function readUserVersion(db) {
  const value = db.selectValue("PRAGMA user_version");
  return typeof value === "number" ? value : 0;
}
function migrateSchema(db) {
  db.exec("PRAGMA foreign_keys = ON");
  const current = readUserVersion(db);
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`\u6570\u636E\u5E93\u7248\u672C ${current} \u9AD8\u4E8E\u5F53\u524D\u6269\u5C55\u652F\u6301\u7684\u7248\u672C ${CURRENT_SCHEMA_VERSION}`);
  }
  let fts5 = false;
  if (current < 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      fts5 = migrateV1(db);
      db.exec("PRAGMA user_version = 1");
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  } else {
    fts5 = ensureFts5(db);
  }
  if (readUserVersion(db) < 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrateV2(db);
      db.exec("PRAGMA user_version = 2");
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  if (readUserVersion(db) < 3) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrateV3(db);
      db.exec("PRAGMA user_version = 3");
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  if (readUserVersion(db) < 4) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrateV4(db);
      db.exec("PRAGMA user_version = 4");
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  db.exec(
    `INSERT INTO sys_meta(key, value) VALUES ('schema_version', '${CURRENT_SCHEMA_VERSION}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  return { version: CURRENT_SCHEMA_VERSION, fts5 };
}

// src/db/search-query.ts
var FTS_MIN_TERM_LENGTH = 3;
var MAX_TERMS = 32;
var MAX_TERM_LENGTH = 12;
var CJK_GRAM_SIZE = 3;
var CJK_DENSE_GRAM_LIMIT = 8;
var CJK_SPARSE_GRAM_STEP = 2;
var MIN_ASCII_TERM_LENGTH = 2;
var STOP_TERMS = /* @__PURE__ */ new Set([
  "\u7EE7\u7EED",
  "\u63A5\u7740",
  "\u7136\u540E",
  "\u4E0B\u4E00",
  "\u518D\u6765",
  "\u5F00\u59CB",
  "\u597D\u7684",
  "\u55EF\u55EF",
  "continue",
  "next",
  "go",
  "ok",
  "okay"
]);
var CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
var WORD_CHARS = /[\p{L}\p{N}]+/gu;
function stripScaffolding(raw) {
  return raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/```[\s\S]*?```/g, " ").replace(/<\/?[A-Za-z_][\w:-]*(?:\s[^>]*)?>/g, " ").replace(/【[^】]*】/g, " ");
}
function isCjk(value) {
  return CJK_PATTERN.test(value);
}
function expandCjkChunk(chunk) {
  if (chunk.length <= CJK_GRAM_SIZE) return [chunk];
  const step = chunk.length <= CJK_DENSE_GRAM_LIMIT ? 1 : CJK_SPARSE_GRAM_STEP;
  const grams = [];
  for (let index = 0; index + CJK_GRAM_SIZE <= chunk.length; index += step) {
    grams.push(chunk.slice(index, index + CJK_GRAM_SIZE));
  }
  const tail = chunk.slice(-CJK_GRAM_SIZE);
  if (grams[grams.length - 1] !== tail) grams.push(tail);
  return grams;
}
function isDegenerate(term) {
  return new Set(term).size <= 1;
}
function buildSearchTerms(raw) {
  const source = stripScaffolding(String(raw ?? ""));
  const terms = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (value) => {
    const term = value.slice(0, MAX_TERM_LENGTH);
    if (!term || isDegenerate(term) || STOP_TERMS.has(term) || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };
  for (const match of source.matchAll(WORD_CHARS)) {
    if (terms.length >= MAX_TERMS) break;
    const word = match[0];
    if (!isCjk(word)) {
      if (word.length >= MIN_ASCII_TERM_LENGTH) push(word.toLowerCase());
      continue;
    }
    if (STOP_TERMS.has(word)) continue;
    for (const chunk of expandCjkChunk(word)) {
      if (terms.length >= MAX_TERMS) break;
      push(chunk);
    }
  }
  return terms.slice(0, MAX_TERMS);
}
function ftsSearchTerms(terms) {
  return terms.filter((term) => term.length >= FTS_MIN_TERM_LENGTH);
}
function toFtsMatchExpression(terms) {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

// src/db/worker/engine.ts
var DEFAULT_FILENAME = "phone-memory.sqlite3";
var SNAPSHOT_DATABASE = "narrative-phone-sqlite";
var SNAPSHOT_STORE = "snapshots";
var SNAPSHOT_KEY = "main";
var DatabaseEngineError = class extends Error {
  code;
  sqliteCode;
  constructor(code, message, sqliteCode) {
    super(message);
    this.name = "DatabaseEngineError";
    this.code = code;
    this.sqliteCode = sqliteCode;
  }
};
var IndexedDbSnapshotStore = class {
  available = typeof indexedDB !== "undefined";
  #databaseName;
  constructor(databaseName = SNAPSHOT_DATABASE) {
    this.#databaseName = databaseName;
  }
  async load() {
    if (!this.available) return null;
    const database = await this.#open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(SNAPSHOT_STORE, "readonly");
        const request = transaction.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY);
        request.onsuccess = () => {
          const value = request.result;
          if (value instanceof Uint8Array) {
            resolve(new Uint8Array(value));
          } else if (value instanceof ArrayBuffer) {
            resolve(new Uint8Array(value.slice(0)));
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error ?? new Error("\u65E0\u6CD5\u8BFB\u53D6 IndexedDB SQLite \u5FEB\u7167"));
      });
    } finally {
      database.close();
    }
  }
  async save(data) {
    if (!this.available) return;
    const database = await this.#open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
        transaction.objectStore(SNAPSHOT_STORE).put(new Uint8Array(data), SNAPSHOT_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("\u65E0\u6CD5\u5199\u5165 IndexedDB SQLite \u5FEB\u7167"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB SQLite \u5FEB\u7167\u4E8B\u52A1\u5DF2\u4E2D\u6B62"));
      });
    } finally {
      database.close();
    }
  }
  #open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(SNAPSHOT_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("\u65E0\u6CD5\u6253\u5F00 SQLite \u5FEB\u7167\u6570\u636E\u5E93"));
      request.onblocked = () => reject(new Error("SQLite \u5FEB\u7167\u6570\u636E\u5E93\u88AB\u5176\u4ED6\u8FDE\u63A5\u963B\u585E"));
    });
  }
};
function defaultSnapshotStore() {
  return typeof indexedDB === "undefined" ? void 0 : new IndexedDbSnapshotStore();
}
async function loadBrowserSqlite() {
  const loaded = await import(new URL("./sqlite/index.mjs", import.meta.url).href);
  if (!isRecord(loaded) || typeof loaded.default !== "function") {
    throw new DatabaseEngineError("engine-unavailable", "SQLite WASM \u6D4F\u89C8\u5668\u5165\u53E3\u7F3A\u5C11\u9ED8\u8BA4\u521D\u59CB\u5316\u51FD\u6570");
  }
  const initializer = loaded.default;
  if (!isRuntimeInit(initializer)) {
    throw new DatabaseEngineError("engine-unavailable", "SQLite WASM \u521D\u59CB\u5316\u51FD\u6570\u7C7B\u578B\u4E0D\u5339\u914D");
  }
  return initializer();
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isRuntimeInit(value) {
  return typeof value === "function";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function opfsFailureReason(error) {
  const detail = errorMessage(error);
  if (globalThis.isSecureContext !== false) return detail;
  const origin = globalThis.location?.origin ?? "\u5F53\u524D\u5730\u5740";
  return `${origin} \u4E0D\u662F\u5B89\u5168\u4E0A\u4E0B\u6587\uFF08\u975E HTTPS \u4E14\u975E localhost\uFF09\uFF0C\u6D4F\u89C8\u5668\u4E0D\u63D0\u4F9B OPFS \u63A5\u53E3\uFF1B\u6539\u7528 HTTPS \u8BBF\u95EE\u5373\u53EF\u6062\u590D OPFS \u6301\u4E45\u5316\u3002\u539F\u59CB\u62A5\u9519\uFF1A${detail}`;
}
function toBindingParams(params) {
  return params;
}
function isMutation(sql) {
  return /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|PRAGMA\s+[^=]+\s*=)/i.test(sql.trim());
}
function changesOf(database, sql) {
  return /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trim()) ? Number(database.changes(false)) : 0;
}
function toNumber(value) {
  return typeof value === "number" ? value : Number(value ?? 0);
}
function normalizeRows(rows) {
  return rows.map((row) => row);
}
function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
function normalizeSearchRow(row) {
  return {
    ...row,
    id: toNumber(row.id),
    scope_id: String(row.scope_id ?? ""),
    kind: String(row.kind ?? ""),
    sheet_id: typeof row.sheet_id === "string" ? row.sheet_id : null,
    row_key: typeof row.row_key === "string" ? row.row_key : null,
    text: String(row.text ?? ""),
    importance: toNumber(row.importance),
    pinned: toNumber(row.pinned),
    valid_from: typeof row.valid_from === "number" ? row.valid_from : null,
    valid_to: typeof row.valid_to === "number" ? row.valid_to : null,
    tokens: toNumber(row.tokens),
    hash: String(row.hash ?? ""),
    updated_at: toNumber(row.updated_at),
    fts_score: toNumber(row.fts_score)
  };
}
var DatabaseEngine = class {
  #options;
  #filename;
  #snapshotStore;
  #sqlite3 = null;
  #database = null;
  #mode = null;
  #status = null;
  #snapshotWarning;
  constructor(options = {}) {
    this.#options = options;
    this.#filename = options.filename ?? DEFAULT_FILENAME;
    this.#snapshotStore = options.snapshotStore ?? defaultSnapshotStore();
  }
  async open() {
    if (this.#status) return this.#status;
    let sqlite3;
    try {
      sqlite3 = await (this.#options.loadSqlite ?? loadBrowserSqlite)();
    } catch (error) {
      if (error instanceof DatabaseEngineError) throw error;
      throw new DatabaseEngineError("engine-unavailable", `SQLite WASM \u521D\u59CB\u5316\u5931\u8D25\uFF1A${errorMessage(error)}`);
    }
    this.#sqlite3 = sqlite3;
    let persistent = false;
    try {
      if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
        const pool = await sqlite3.installOpfsSAHPoolVfs({
          directory: this.#options.opfsDirectory ?? "/narrative-phone",
          initialCapacity: 4
        });
        this.#database = new pool.OpfsSAHPoolDb(this.#filename);
        this.#mode = "opfs-sahpool";
        persistent = true;
      }
    } catch (error) {
      this.#database = null;
      this.#mode = null;
      this.#snapshotWarning = `OPFS SAH pool \u4E0D\u53EF\u7528\uFF0C\u5DF2\u964D\u7EA7\uFF1A${opfsFailureReason(error)}`;
    }
    if (!this.#database) {
      try {
        this.#database = new sqlite3.oo1.DB(":memory:");
        this.#mode = this.#snapshotStore?.available ? "indexeddb-snapshot" : "memory";
        persistent = this.#mode === "indexeddb-snapshot";
        if (this.#mode === "indexeddb-snapshot") await this.#restoreSnapshot();
      } catch (error) {
        this.#database?.close();
        this.#database = null;
        throw new DatabaseEngineError("engine-unavailable", `SQLite \u5185\u5B58\u5E93\u521D\u59CB\u5316\u5931\u8D25\uFF1A${errorMessage(error)}`);
      }
    }
    try {
      const migration = migrateSchema(this.#database);
      if (this.#mode === "indexeddb-snapshot") await this.#saveSnapshot();
      this.#status = {
        mode: this.#mode ?? "memory",
        persistent,
        sqliteVersion: sqlite3.version.libVersion,
        fts5: migration.fts5,
        snapshotAvailable: this.#snapshotStore?.available ?? false,
        ...this.#snapshotWarning ? { warning: this.#snapshotWarning } : {}
      };
      return this.#status;
    } catch (error) {
      this.#database?.close();
      this.#database = null;
      throw new DatabaseEngineError("engine-unavailable", `\u6570\u636E\u5E93 schema \u521D\u59CB\u5316\u5931\u8D25\uFF1A${errorMessage(error)}`);
    }
  }
  status() {
    if (!this.#status) throw new DatabaseEngineError("engine-unavailable", "\u6570\u636E\u5E93\u5C1A\u672A\u6253\u5F00");
    return this.#status;
  }
  execute(statement) {
    const database = this.#requireDatabase();
    try {
      const rows = database.exec({
        sql: statement.sql,
        ...toBindingParams(statement.params) ? { bind: toBindingParams(statement.params) } : {},
        rowMode: "object",
        returnValue: "resultRows"
      });
      const result = {
        rows: normalizeRows(rows),
        changes: changesOf(database, statement.sql),
        lastInsertRowId: this.#lastInsertRowId(database)
      };
      if (isMutation(statement.sql) && this.#mode === "indexeddb-snapshot") void this.#saveSnapshot();
      return result;
    } catch (error) {
      throw this.#toSqlError(error);
    }
  }
  async transaction(statements) {
    const database = this.#requireDatabase();
    const results = [];
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const statement of statements) {
        results.push(this.#executeWithoutSnapshot(statement));
      }
      database.exec("COMMIT");
      if (this.#mode === "indexeddb-snapshot") await this.#saveSnapshot();
      return results;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
      }
      throw this.#toSqlError(error);
    }
  }
  /**
   * 自动注入候选检索。
   *
   * 候选集刻意收窄成「非 manual 表的行」：
   * - `sheet_id IS NOT NULL` 排除记忆库条目投影。记忆库有自己的编号选取与独立注入区块，
   *   数据中心再模糊召回同一批内容只会在同一个请求里重复注入整段正文。
   * - `policy <> 'manual'` 让「仅手动查询，不自动注入」这条策略真正生效。
   *
   * 检索词由 `buildSearchTerms` 切出后按 OR 匹配；一个词都切不出来时退化为「最近候选」，
   * 而不是拿整句去做子串匹配（trigram 短语与 LIKE 都会因此几乎永不命中）。
   */
  search(scopeId, query, limit = 20) {
    const database = this.#requireDatabase();
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const terms = buildSearchTerms(query);
    const ftsTerms = ftsSearchTerms(terms);
    const mode = this.status().fts5 && ftsTerms.length > 0 ? "fts5" : terms.length > 0 ? "like" : "recent";
    const rows = mode === "fts5" ? database.exec({
      sql: `
            SELECT d.*, bm25(mem_fts) AS fts_score
            FROM mem_fts
            JOIN mem_doc AS d ON d.id = mem_fts.rowid
            JOIN sheet AS s ON s.id = d.sheet_id
            WHERE d.scope_id = ? AND s.policy <> 'manual' AND mem_fts MATCH ?
            ORDER BY bm25(mem_fts), d.pinned DESC, d.importance DESC, d.updated_at DESC
            LIMIT ?
          `,
      bind: [scopeId, toFtsMatchExpression(ftsTerms), boundedLimit],
      rowMode: "object",
      returnValue: "resultRows"
    }) : mode === "like" ? database.exec({
      sql: `
              SELECT d.*, 0.0 AS fts_score
              FROM mem_doc AS d
              JOIN sheet AS s ON s.id = d.sheet_id
              WHERE d.scope_id = ? AND s.policy <> 'manual'
                AND (${terms.map(() => "d.text LIKE ? ESCAPE '\\'").join(" OR ")})
              ORDER BY d.pinned DESC, d.importance DESC, d.updated_at DESC
              LIMIT ?
            `,
      bind: [scopeId, ...terms.map((term) => `%${escapeLike(term)}%`), boundedLimit],
      rowMode: "object",
      returnValue: "resultRows"
    }) : database.exec({
      sql: `
              SELECT d.*, 0.0 AS fts_score
              FROM mem_doc AS d
              JOIN sheet AS s ON s.id = d.sheet_id
              WHERE d.scope_id = ? AND s.policy <> 'manual'
              ORDER BY d.pinned DESC, d.importance DESC, d.updated_at DESC, d.id DESC
              LIMIT ?
            `,
      bind: [scopeId, boundedLimit],
      rowMode: "object",
      returnValue: "resultRows"
    });
    return {
      rows: normalizeRows(rows).map(normalizeSearchRow),
      mode,
      queryLength: query.trim().length
    };
  }
  exportDatabase() {
    const database = this.#requireDatabase();
    const sqlite3 = this.#sqlite3;
    if (!sqlite3 || database.pointer === void 0) {
      throw new DatabaseEngineError("engine-unavailable", "SQLite \u5BFC\u51FA\u65F6\u6570\u636E\u5E93\u53E5\u67C4\u4E0D\u53EF\u7528");
    }
    try {
      return sqlite3.capi.sqlite3_js_db_export(database.pointer);
    } catch (error) {
      throw new DatabaseEngineError("engine-unavailable", `SQLite \u5BFC\u51FA\u5931\u8D25\uFF1A${errorMessage(error)}`);
    }
  }
  async close() {
    if (this.#database && this.#mode === "indexeddb-snapshot") await this.#saveSnapshot();
    this.#database?.close();
    this.#database = null;
    this.#status = null;
  }
  #executeWithoutSnapshot(statement) {
    const database = this.#requireDatabase();
    const rows = database.exec({
      sql: statement.sql,
      ...toBindingParams(statement.params) ? { bind: toBindingParams(statement.params) } : {},
      rowMode: "object",
      returnValue: "resultRows"
    });
    return {
      rows: normalizeRows(rows),
      changes: changesOf(database, statement.sql),
      lastInsertRowId: this.#lastInsertRowId(database)
    };
  }
  #lastInsertRowId(database) {
    if (!this.#sqlite3 || database.pointer === void 0) return 0n;
    return this.#sqlite3.capi.sqlite3_last_insert_rowid(database.pointer);
  }
  #requireDatabase() {
    if (!this.#database) throw new DatabaseEngineError("engine-unavailable", "\u6570\u636E\u5E93\u5C1A\u672A\u6253\u5F00");
    return this.#database;
  }
  #toSqlError(error) {
    if (error instanceof DatabaseEngineError) return error;
    return new DatabaseEngineError("sql-error", errorMessage(error));
  }
  async #restoreSnapshot() {
    const store = this.#snapshotStore;
    const sqlite3 = this.#sqlite3;
    const database = this.#database;
    if (!store || !sqlite3 || !database) return;
    const snapshot = await store.load();
    if (!snapshot || snapshot.byteLength === 0) return;
    if (database.pointer === void 0) throw new DatabaseEngineError("engine-unavailable", "SQLite \u5185\u5B58\u5E93\u53E5\u67C4\u4E0D\u53EF\u7528");
    let pointer = null;
    try {
      pointer = sqlite3.wasm.allocFromTypedArray(snapshot);
      const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
      const resultCode = sqlite3.capi.sqlite3_deserialize(
        database.pointer,
        "main",
        pointer,
        snapshot.byteLength,
        snapshot.byteLength,
        flags
      );
      pointer = null;
      if (resultCode !== sqlite3.capi.SQLITE_OK) {
        throw new Error(`sqlite3_deserialize \u8FD4\u56DE\u9519\u8BEF\u7801 ${resultCode}`);
      }
    } catch (error) {
      if (pointer !== null) sqlite3.wasm.dealloc(pointer);
      this.#snapshotWarning = `IndexedDB SQLite \u5FEB\u7167\u635F\u574F\uFF0C\u5DF2\u4F7F\u7528\u5185\u5B58\u526F\u672C\uFF1A${errorMessage(error)}`;
    }
  }
  async #saveSnapshot() {
    const store = this.#snapshotStore;
    if (!store || !this.#database) return;
    try {
      await store.save(this.exportDatabase());
    } catch (error) {
      this.#snapshotWarning = `IndexedDB SQLite \u5FEB\u7167\u5199\u5165\u5931\u8D25\uFF1A${errorMessage(error)}`;
    }
  }
};

// src/db/protocol.ts
var DB_PROTOCOL_VERSION = 1;
function isDbValue(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || value instanceof Uint8Array || value instanceof Int8Array || value instanceof ArrayBuffer;
}
function isDbParams(value) {
  if (Array.isArray(value)) return value.every(isDbValue);
  if (!isRecord2(value)) return false;
  return Object.values(value).every(isDbValue);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
var REQUEST_KINDS = ["open", "execute", "transaction", "search", "export", "status", "close"];
function isDbRequest(value) {
  if (!isRecord2(value)) return false;
  return value.version === DB_PROTOCOL_VERSION && typeof value.id === "string" && value.id.length > 0 && typeof value.kind === "string" && REQUEST_KINDS.includes(value.kind) && isRecord2(value.payload);
}
function createSuccessResponse(id, kind, payload) {
  return { version: DB_PROTOCOL_VERSION, id, ok: true, kind, payload };
}
function createErrorResponse(id, error) {
  return { version: DB_PROTOCOL_VERSION, id, ok: false, error };
}

// src/db/worker/entry.ts
var workerScope = globalThis;
var engine = new DatabaseEngine();
var serializedWork = Promise.resolve();
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function toErrorPayload(error) {
  if (error instanceof DatabaseEngineError) {
    return {
      code: error.code,
      message: error.message,
      ...error.sqliteCode === void 0 ? {} : { sqliteCode: error.sqliteCode }
    };
  }
  return { code: "protocol-error", message: messageOf(error) };
}
function asStatement(value) {
  if (!isRecord3(value) || typeof value.sql !== "string") throw new Error("\u7F3A\u5C11\u6709\u6548 SQL");
  const input = value.params;
  if (input !== void 0 && !isDbParams(input)) throw new Error("SQL \u53C2\u6570\u4E0D\u662F\u53EF\u7ED3\u6784\u5316\u514B\u9686\u7684 SQLite \u503C");
  return {
    sql: value.sql,
    ...input === void 0 ? {} : { params: input }
  };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
async function handleRequest(request) {
  try {
    switch (request.kind) {
      case "open": {
        const status = await engine.open();
        workerScope.postMessage(createSuccessResponse(request.id, "open", status));
        return;
      }
      case "status": {
        workerScope.postMessage(createSuccessResponse(request.id, "status", engine.status()));
        return;
      }
      case "execute": {
        const result = engine.execute(asStatement(request.payload));
        workerScope.postMessage(createSuccessResponse(request.id, "execute", result));
        return;
      }
      case "transaction": {
        const statements = request.payload.statements.map(asStatement);
        const result = await engine.transaction(statements);
        workerScope.postMessage(createSuccessResponse(request.id, "transaction", result));
        return;
      }
      case "search": {
        const result = engine.search(request.payload.scopeId, request.payload.query, request.payload.limit);
        workerScope.postMessage(createSuccessResponse(request.id, "search", result));
        return;
      }
      case "export": {
        const result = {
          data: engine.exportDatabase(),
          filename: "phone-memory.sqlite3",
          mimeType: "application/x-sqlite3"
        };
        workerScope.postMessage(createSuccessResponse(request.id, "export", result));
        return;
      }
      case "close": {
        await engine.close();
        workerScope.postMessage(createSuccessResponse(request.id, "close", {}));
        return;
      }
      default: {
        throw new Error("\u672A\u77E5\u6570\u636E\u5E93\u64CD\u4F5C");
      }
    }
  } catch (error) {
    workerScope.postMessage(createErrorResponse(request.id, toErrorPayload(error)));
  }
}
workerScope.addEventListener("message", (event) => {
  const value = event.data;
  if (!isDbRequest(value)) {
    workerScope.postMessage(
      createErrorResponse("", { code: "protocol-error", message: "\u6570\u636E\u5E93 Worker \u6536\u5230\u683C\u5F0F\u65E0\u6548\u7684\u8BF7\u6C42" })
    );
    return;
  }
  serializedWork = serializedWork.then(() => handleRequest(value)).catch((error) => {
    workerScope.postMessage(
      createErrorResponse(value.id, { code: "protocol-error", message: messageOf(error) })
    );
  });
});
//# sourceMappingURL=db-worker.js.map
