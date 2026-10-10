// Minimal D1-compatible wrapper over Node's built-in SQLite, so tests run the
// real migrations and the real SQL without a Workers runtime.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const migrationsDir = fileURLToPath(new URL("../../worker/migrations", import.meta.url));

export function createTestDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).sort()) db.exec(readFileSync(join(migrationsDir, file), "utf8"));

  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])), success: true }),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    run: async () => ({ success: true, meta: db.prepare(sql).run(...(params as never[])) }),
  });

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}
