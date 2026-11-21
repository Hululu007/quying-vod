// SQLite 兼容层：优先使用 Node 内置的 node:sqlite（Node 22.5+，无需原生编译），
// 不可用时回退到 better-sqlite3（Node 20 等老运行时）。
// 对外暴露与 better-sqlite3 相同的 Database 用法：pragma / exec / prepare / transaction / close。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadNodeSqlite() {
  try {
    const sqlite = require('node:sqlite');
    return sqlite && typeof sqlite.DatabaseSync === 'function' ? sqlite : null;
  } catch {
    return null;
  }
}

class NodeSqliteDatabase {
  constructor(filename) {
    const sqlite = loadNodeSqlite();
    this.db = new sqlite.DatabaseSync(filename);
  }

  pragma(statement) {
    this.db.exec(`PRAGMA ${statement}`);
    return this;
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      run: (...args) => statement.run(...args),
      get: (...args) => statement.get(...args),
      all: (...args) => statement.all(...args),
    };
  }

  transaction(fn) {
    return (...args) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    };
  }

  close() {
    this.db.close();
  }
}

function loadDatabase() {
  if (loadNodeSqlite()) return NodeSqliteDatabase;
  const mod = require('better-sqlite3');
  return mod && mod.default ? mod.default : mod;
}

const Database = loadDatabase();

export default Database;
