/**
 * Builds the two SQL files that ship with the deployed site:
 *
 *   public/setup/NMBR-supabase-setup.sql          — the whole database definition
 *   public/setup/NMBR-demonstration-data.sql      — optional fictional sample data
 *
 * They exist so an administrator can set the central database up from a phone:
 * download the file in the app, paste it into the Supabase SQL Editor, run it.
 * The setup file is assembled from supabase/migrations/ in order, so it can never
 * drift from the schema the application was tested against.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'supabase', 'migrations')
const outDir = join(root, 'public', 'setup')

const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
if (migrationFiles.length === 0) {
  console.error('No migration files found in supabase/migrations — nothing to build.')
  process.exit(1)
}

const header = `-- =====================================================================
--  NABUA MUNICIPAL BARANGAY REGISTRY (NMBR)
--  Centralized Member Registry & Duplicate Prevention System
--
--  DATABASE SETUP — run this once on the Supabase project.
--
--  HOW TO USE
--    1. Open the Supabase project.
--    2. Left menu -> SQL Editor -> New query.
--    3. Copy this whole file, paste it in, press Run.
--    4. Wait for "Success. No rows returned".
--    5. Back in the NMBR app, press "Check the server again" in the Sync
--       Centre: everything that was queued on the device uploads by itself.
--
--  This file is safe to run more than once — every statement is idempotent.
--  It contains no secrets and no resident data: only the tables, the duplicate
--  matching functions, the audit triggers, the row level security policies and
--  the stored procedures the application calls.
--
--  Built from these migration files, in this order (the file is reproducible:
--  the same sources always produce byte-identical output):
${migrationFiles.map((f) => `--      supabase/migrations/${f}`).join('\n')}
-- =====================================================================

`

const body = migrationFiles
  .map((file) => {
    const sql = readFileSync(join(migrationsDir, file), 'utf8').trimEnd()
    return `\n\n-- #####################################################################\n-- # ${file}\n-- #####################################################################\n\n${sql}\n`
  })
  .join('')

const footer = `\n\n-- =====================================================================\n--  Setup complete. Next: create the staff accounts under Authentication ->\n--  Users, then add the matching rows to the users table (see\n--  docs/DEPLOY_CLOUDFLARE.md, step 3). Demonstration data is a separate file.\n-- =====================================================================\n`

mkdirSync(outDir, { recursive: true })
const setupPath = join(outDir, 'NMBR-supabase-setup.sql')
writeFileSync(setupPath, header + body + footer, 'utf8')

// Optional sample data (fictional) for training and demonstrations.
const seedSource = join(root, 'supabase', 'seed.sql')
const seedHeader = `-- =====================================================================
--  NMBR — OPTIONAL DEMONSTRATION DATA  (fictional, for training only)
--
--  Run NMBR-supabase-setup.sql FIRST, then run this file the same way
--  (SQL Editor -> paste -> Run). It loads 12 barangays and 160 fictional
--  members with deliberate duplicate cases so staff can practise.
--
--  Do NOT run this on a database that already holds real resident records.
--  It is idempotent, so a second run changes nothing.
-- =====================================================================

`
writeFileSync(join(outDir, 'NMBR-demonstration-data.sql'), seedHeader + readFileSync(seedSource, 'utf8'), 'utf8')

const kb = (p) => `${(readFileSync(p).length / 1024).toFixed(0)} KB`
console.log(`✓ public/setup/NMBR-supabase-setup.sql (${kb(setupPath)}) from ${migrationFiles.length} migrations`)
console.log(`✓ public/setup/NMBR-demonstration-data.sql (${kb(join(outDir, 'NMBR-demonstration-data.sql'))})`)
