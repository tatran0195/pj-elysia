import { db } from '@repo/db';
import { resetRateLimiters } from '@repo/auth';
import { sql } from 'drizzle-orm';

// TRUNCATEs every table in the test database so each test starts clean. Two
// guards keep this from ever running against a real database: NODE_ENV must be
// "test" and DATABASE_URL must name a database containing "test". Call it in a
// beforeEach (or beforeAll) in every integration test that touches the DB.
export async function resetDb(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const dbName = url.split('/').pop()?.split('?')[0] ?? '';
  if (process.env.NODE_ENV !== 'test' || !dbName.includes('test')) {
    throw new Error(
      `resetDb refused: expected NODE_ENV=test and a DATABASE_URL whose database name contains "test", got NODE_ENV=${process.env.NODE_ENV} db=${dbName}. Use .env.test.`,
    );
  }

  // All application and auth tables live in the public schema; the drizzle
  // migrations bookkeeping table is excluded so migrations are not re-run.
  //
  // TRUNCATE is the obvious tool but it is the wrong one here: truncating a
  // hundred-odd tables rewrites and fsyncs a relation file for each of them,
  // which costs seconds per test on ordinary disks. Instead, find the tables
  // that actually hold rows (a cheap EXISTS per table) and DELETE from just
  // those inside one transaction with FK triggers disabled — identical end
  // state, a few milliseconds. Sequences are reset so ids stay predictable.
  const tables = await tableNames();
  if (tables.length === 0) return;
  const nonEmpty = (await db.execute(
    sql.raw(tables.map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM "${t}")`).join(' UNION ALL ')),
  )) as unknown as Array<{ t: string }>;
  if (nonEmpty.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL session_replication_role = replica'));
      for (const { t } of nonEmpty) await tx.execute(sql.raw(`DELETE FROM "${t}"`));
    });
  }
  const sequences = (await db.execute(sql`
    SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL
  `)) as unknown as Array<{ sequencename: string }>;
  for (const { sequencename } of sequences) {
    await db.execute(sql.raw(`ALTER SEQUENCE "${sequencename}" RESTART`));
  }

  // The sign-in and sign-up limiters keep their windows in memory, so truncating
  // the tables is not enough: without this, a suite that signs the same address up
  // in twenty tests trips the limit half way through.
  resetRateLimiters();
}

let cachedTables: string[] | null = null;
async function tableNames(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const rows = (await db.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `)) as unknown as Array<{ tablename: string }>;
  cachedTables = rows.map((r) => r.tablename);
  return cachedTables;
}
