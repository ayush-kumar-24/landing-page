/**
 * Applies db/schema.sql to the database in DATABASE_URL.
 *
 *   node --env-file=.env.local scripts/apply-schema.mjs
 *
 * Every statement in that file is idempotent, so this is safe to run against a
 * database that is already current -- it is how a database that has drifted is
 * brought back, not a one-time install. Nothing is dropped and no row is
 * touched; the file only creates what is missing.
 *
 * This exists because the schema had no runner: db/schema.sql said to apply it
 * with psql by hand, so production silently sat several ALTERs behind the repo
 * and every registration failed on a column the code expected and the database
 * did not have.
 */
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("FAIL  DATABASE_URL is not set. Did you pass --env-file=.env.local?");
  process.exit(1);
}

// Same settings as app/lib/db.ts: transaction-mode poolers reject prepared
// statements, and a one-shot script has no use for a pool.
const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

/** The columns the app reads and writes, so the report says something useful. */
async function columnsOfBetaUsers() {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'beta_users'
    ORDER BY column_name
  `;
  return rows.map((r) => r.column_name);
}

try {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");

  const before = await columnsOfBetaUsers();
  console.log(before.length
    ? `before  beta_users: ${before.join(", ")}`
    : "before  beta_users does not exist yet");

  // `.simple()`: schema.sql is many statements in one string, and the extended
  // protocol the driver uses by default accepts only one per round trip.
  await sql.unsafe(schema).simple();

  const after = await columnsOfBetaUsers();
  const added = after.filter((c) => !before.includes(c));
  console.log(`after   beta_users: ${after.join(", ")}`);
  console.log(added.length ? `ADDED   ${added.join(", ")}` : "OK      already up to date, nothing to add");
} catch (error) {
  console.error(`FAIL    ${error.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
