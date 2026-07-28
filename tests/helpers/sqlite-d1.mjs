import { DatabaseSync } from 'node:sqlite';

class BoundStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new BoundStatement(this.database, this.sql, bindings);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.bindings);
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings), success: true };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1 {
  constructor(schemaSql) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(schemaSql);
  }

  prepare(sql) {
    return new BoundStatement(this.sqlite, sql);
  }

  withSession() {
    return this;
  }

  batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

const guardedStatement = (statement, owner) => ({
  __inner: statement,
  bind(...bindings) {
    owner.maxObservedBindings = Math.max(owner.maxObservedBindings, bindings.length);
    if (bindings.length > owner.maxBindings) {
      throw new RangeError(`D1 statement uses ${bindings.length} bindings; limit is ${owner.maxBindings}`);
    }
    return guardedStatement(statement.bind(...bindings), owner);
  },
  first() {
    owner.queryCount += 1;
    if (owner.queryCount > owner.maxQueries) throw new RangeError(`D1 invocation exceeded ${owner.maxQueries} queries`);
    return statement.first();
  },
  all() {
    owner.queryCount += 1;
    if (owner.queryCount > owner.maxQueries) throw new RangeError(`D1 invocation exceeded ${owner.maxQueries} queries`);
    return statement.all();
  },
  run() {
    owner.queryCount += 1;
    if (owner.queryCount > owner.maxQueries) throw new RangeError(`D1 invocation exceeded ${owner.maxQueries} queries`);
    return statement.run();
  },
});

export class BudgetGuardD1 {
  constructor(db, { maxBindings = 100, maxQueries = 50 } = {}) {
    this.db = db;
    this.maxBindings = maxBindings;
    this.maxQueries = maxQueries;
    this.maxObservedBindings = 0;
    this.maxBatchSize = 0;
    this.queryCount = 0;
  }

  prepare(sql) {
    return guardedStatement(this.db.prepare(sql), this);
  }

  withSession() {
    return this;
  }

  batch(statements) {
    this.maxBatchSize = Math.max(this.maxBatchSize, statements.length);
    if (statements.length > this.maxQueries) {
      throw new RangeError(`D1 batch uses ${statements.length} queries; limit is ${this.maxQueries}`);
    }
    this.queryCount += statements.length;
    if (this.queryCount > this.maxQueries) throw new RangeError(`D1 invocation exceeded ${this.maxQueries} queries`);
    return this.db.batch(statements.map((statement) => statement.__inner || statement));
  }
}
