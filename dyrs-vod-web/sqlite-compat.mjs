// SQLite 驱动封装：基于 Node 内置的 node:sqlite（Node 24+ 稳定），
// 提供与 better-sqlite3 一致的 pragma / exec / prepare / transaction 接口，
// 无需任何原生模块编译，本地与 Vercel 行为一致。
import { DatabaseSync } from 'node:sqlite';

export default class SqliteDatabase {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
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
