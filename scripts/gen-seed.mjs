/**
 * NMBR seed data generator.
 *
 * Produces two artefacts from ONE source of truth so the demo dataset is
 * identical in the offline (browser) store and in Supabase:
 *   • src/data/seed.json   — consumed by the local backend / demo mode
 *   • supabase/seed.sql    — run in the Supabase SQL editor after migrations
 *
 * Run: npm run seed:sql
 *
 * All names, addresses and numbers are FICTIONAL and generated deterministically.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- PRNG
let seedState = 20260914
function rnd() {
  // mulberry32 — deterministic so re-running produces the same dataset
  seedState |= 0
  seedState = (seedState + 0x6d2b79f5) | 0
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1))

// ---------------------------------------------------------------- reference
const BARANGAYS = [
  { name: 'San Isidro', district: 'Poblacion' },
  { name: 'San Roque', district: 'Poblacion' },
  { name: 'La Purisima', district: 'Poblacion' },
  { name: 'Sagrada Familia', district: 'Poblacion' },
  { name: 'San Antonio', district: 'North' },
  { name: 'San Juan', district: 'North' },
  { name: 'San Nicolas', district: 'East' },
  { name: 'Santa Cruz', district: 'East' },
  { name: 'San Miguel', district: 'South' },
  { name: 'San Rafael', district: 'South' },
  { name: 'Sto. Domingo', district: 'West' },
  { name: 'San Pedro', district: 'West' },
]

const USERS = [
  { name: 'Engr. Ramon Villaflor', email: 'admin@nabua.gov.ph', role: 'SYSTEM_ADMIN', password: 'Admin@NMBR2026' },
  { name: 'Maria Santos', email: 'maria.santos@nabua.gov.ph', role: 'ADMINISTRATOR', password: 'Admin@NMBR2026' },
  { name: 'Josefina Ramos', email: 'josefina.ramos@nabua.gov.ph', role: 'ADMINISTRATOR', password: 'Admin@NMBR2026' },
  { name: 'Pedro Reyes', email: 'pedro.reyes@nabua.gov.ph', role: 'ENCODER', password: 'Encoder@2026' },
  { name: 'Ana Villanueva', email: 'ana.villanueva@nabua.gov.ph', role: 'ENCODER', password: 'Encoder@2026' },
  { name: 'Liza Mercado', email: 'liza.mercado@nabua.gov.ph', role: 'ENCODER', password: 'Encoder@2026' },
  { name: 'Cornelio Bautista', email: 'viewer@nabua.gov.ph', role: 'VIEWER', password: 'Viewer@2026' },
]

const FIRST_M = ['Juan', 'Jose', 'Pedro', 'Ramon', 'Carlos', 'Antonio', 'Rogelio', 'Ernesto', 'Fernando', 'Wilfredo',
  'Roberto', 'Eduardo', 'Mario', 'Rafael', 'Alfredo', 'Nestor', 'Danilo', 'Rodolfo', 'Benjamin', 'Rene',
  'Emmanuel', 'Arnold', 'Joel', 'Ryan', 'Mark', 'Jhun', 'Christopher', 'Alvin', 'Dennis', 'Rodel']
const FIRST_F = ['Maria', 'Ana', 'Josefina', 'Rosario', 'Luzviminda', 'Cristina', 'Marilou', 'Editha', 'Nena', 'Lorna',
  'Teresita', 'Gloria', 'Lourdes', 'Jocelyn', 'Marites', 'Elena', 'Rowena', 'Aurora', 'Melinda', 'Evelyn',
  'Perlita', 'Winnie', 'Sheila', 'Catherine', 'Grace', 'Divina', 'Bernadette', 'Myrna', 'Chona', 'Arlene']
const MIDDLE = ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Villanueva', 'Mercado', 'Ramos', 'Gonzales', 'Aquino', 'Domingo',
  'Salvador', 'Navarro', 'Marquez', 'Fernandez', 'Castillo', 'Rivera', 'Ocampo', 'Bermudo', 'Padilla', 'Sarmiento',
  'Imperial', 'Bonaobra', 'Tolentino', 'Velasco', 'Arellano']
const LAST = ['Dela Cruz', 'Santos', 'Reyes', 'Bautista', 'Villanueva', 'Mercado', 'Ramos', 'Gonzales', 'Aquino', 'Domingo',
  'Salvador', 'Navarro', 'Marquez', 'Fernandez', 'Castillo', 'Rivera', 'Ocampo', 'Bermudo', 'Padilla', 'Sarmiento',
  'Imperial', 'Bonaobra', 'Tolentino', 'Velasco', 'Arellano', 'Albao', 'Baldovino', 'Cordial', 'Dacillo', 'Enciso',
  'Fabregas', 'Gumabao', 'Halcon', 'Isidro', 'Jalop', 'Kalaw', 'Laguardia', 'Macatangay', 'Nacario', 'Orobia']
const SUFFIXES = ['', '', '', '', '', 'Jr.', 'Sr.', 'III']
const PUROKS = ['Purok 1', 'Purok 2', 'Purok 3', 'Purok 4', 'Purok 5', 'Purok 6', 'Purok 7', 'Sitio Balongay', 'Sitio Iraya', 'Sitio Ilawod']
const CIVIL = ['SINGLE', 'SINGLE', 'MARRIED', 'MARRIED', 'WIDOWED', 'SEPARATED']

function phone() {
  return `09${int(10, 99)}${int(1000000, 9999999)}`.slice(0, 11)
}
function dobFor(age) {
  const year = 2026 - age
  const month = int(1, 12)
  const day = int(1, 28)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const persons = []
let refSeq = 2417
function addPerson(p) {
  const id = `p${(persons.length + 1).toString().padStart(4, '0')}`
  const person = {
    id,
    reference_no: `NMBR-${(refSeq++).toString().padStart(6, '0')}`,
    first_name: p.first_name,
    middle_name: p.middle_name ?? null,
    last_name: p.last_name,
    suffix: p.suffix ?? null,
    date_of_birth: p.date_of_birth ?? null,
    sex: p.sex ?? null,
    civil_status: p.civil_status ?? null,
    contact_number: p.contact_number ?? null,
    address: p.address ?? null,
    purok: p.purok ?? null,
    barangay: p.barangay,
    status: p.status ?? 'ACTIVE',
    remarks: p.remarks ?? null,
    identity_key: p.identity_key ?? null,
    identity_lock: p.identity_lock ?? true,
    created_days_ago: p.created_days_ago ?? (rnd() < 0.03 ? 0 : int(1, 540)),
    updated_days_ago: p.updated_days_ago ?? int(0, 30),
    encodedBy: p.encodedBy ?? pick(['pedro.reyes@nabua.gov.ph', 'ana.villanueva@nabua.gov.ph', 'liza.mercado@nabua.gov.ph']),
    household_no: p.household_no ?? null,
    history: p.history ?? null,
  }
  persons.push(person)
  return person
}

// ---------------------------------------------------------------- random population
const TARGET = 138
const usedIdentity = new Set()
const householdPool = []
for (let i = 1; i <= 24; i++) {
  householdPool.push({ household_no: `HH-${2026}-${String(i).padStart(4, '0')}`, barangay: pick(BARANGAYS).name })
}

let attempts = 0
while (persons.length < TARGET && attempts < 4000) {
  attempts++
  const sexPick = rnd() < 0.49 ? 'MALE' : 'FEMALE'
  const sex = rnd() < 0.03 ? null : sexPick            // a few records lack sex (data quality)
  const first = sex === 'MALE' ? pick(FIRST_M) : pick(FIRST_F)
  const middle = rnd() < 0.12 ? null : pick(MIDDLE)                 // some records legitimately lack a middle name
  const last = pick(LAST)
  const suffix = pick(SUFFIXES)
  const age = int(0, 92)
  const dob = rnd() < 0.06 ? null : dobFor(age)                     // some records lack a birthdate (data quality)
  const barangay = pick(BARANGAYS).name
  const purok = pick(PUROKS)
  const key = `${(last || '').toUpperCase()}|${first.toUpperCase()}|${(middle || '').toUpperCase()}|${(suffix || '').toUpperCase()}|${dob ?? ''}`
  if (dob && usedIdentity.has(key)) continue
  if (dob) usedIdentity.add(key)

  const hh = rnd() < 0.45 ? pick(householdPool) : null
  const status = rnd() < 0.045 ? 'INACTIVE' : rnd() < 0.02 ? 'DECEASED' : 'ACTIVE'
  const contact = rnd() < 0.16 ? null
    : rnd() < 0.04 ? `${int(100, 999)}-${int(100, 999)}`   // invalid / incomplete number
    : phone()

  addPerson({
    first_name: first, middle_name: middle, last_name: last, suffix: suffix || null,
    date_of_birth: dob, sex, civil_status: age < 18 ? 'SINGLE' : pick(CIVIL),
    contact_number: contact, purok,
    address: `${purok}, ${barangay}, Nabua, Camarines Sur`,
    barangay, status,
    household_no: hh ? hh.household_no : null,
  })
}

// ---------------------------------------------------------------- intentional duplicate cases
const duplicateCases = []

/** Case A: two live master records that share a name + birthdate.
 *  These exist because a supervisor verified them as different residents, which
 *  is why they carry a "#n" identity discriminator and are flagged FOR_REVIEW. */
const namesakes = [
  { first: 'Juan', middle: 'Santos', last: 'Dela Cruz', dob: '1985-01-12', sex: 'MALE', barangay: 'San Isidro', purok: 'Purok 3', contact: '09171234567' },
  { first: 'Rosario', middle: 'Bautista', last: 'Navarro', dob: '1979-07-04', sex: 'FEMALE', barangay: 'La Purisima', purok: 'Purok 2', contact: '09182223333' },
  { first: 'Pedro', middle: null, last: 'Aquino', dob: '1968-11-23', sex: 'MALE', barangay: 'San Roque', purok: 'Sitio Iraya', contact: null },
]
for (const n of namesakes) {
  const base = addPerson({
    first_name: n.first, middle_name: n.middle, last_name: n.last, suffix: null,
    date_of_birth: n.dob, sex: n.sex, civil_status: 'MARRIED', contact_number: n.contact,
    purok: n.purok, address: `${n.purok}, ${n.barangay}, Nabua, Camarines Sur`,
    barangay: n.barangay, status: 'ACTIVE', created_days_ago: int(120, 400),
  })
  const namesakePurok = n.purok === 'Purok 3' ? 'Purok 7' : n.purok
  const namesake = addPerson({
    first_name: n.first.toUpperCase(), middle_name: n.middle, last_name: n.last.toUpperCase(), suffix: null,
    date_of_birth: n.dob, sex: n.sex, civil_status: 'SINGLE', contact_number: n.contact,
    purok: namesakePurok, address: `${namesakePurok}, ${n.barangay}, Nabua, Camarines Sur`,
    barangay: n.barangay, status: 'FOR_REVIEW', created_days_ago: int(1, 60),
    remarks: 'Verified with barangay records: two different residents share the same name and birthdate.',
  })
  // The namesake carries a discriminator on its identity key, exactly as the
  // database guard produces during a verified override (assigned by the pass below).
  namesake.remarks = namesake.remarks

  duplicateCases.push({
    a: base.id, b: namesake.id, score: 100, band: 'VERY_LIKELY', status: 'PENDING', source: 'LIVE_CHECK',
    fields: ['last_name', 'first_name', 'middle_name', 'date_of_birth', 'sex'],
    notes: 'Automatically queued: identical identity key accepted with an explicit override. Verify that these are genuinely two different residents.',
  })
}

/** Case B: same person encoded twice with slightly different spelling.
 *  Fuzzy matches that must be reviewed and merged. */
const nearCases = [
  {
    a: { first: 'Marilou', middle: 'Reyes', last: 'Bermudo', dob: '1990-03-18', sex: 'FEMALE', barangay: 'San Antonio', purok: 'Purok 1', contact: '09193334444' },
    b: { first: 'MARILOU', middle: 'REYES', last: 'BERMUDO', dob: '1990-03-18', sex: 'FEMALE', barangay: 'San Antonio', purok: 'Purok 1', contact: '09193334444' },
    note: 'Different capitalisation only — same person encoded twice.',
  },
  {
    a: { first: 'Wilfredo', middle: 'Castillo', last: 'Macatangay', dob: '1975-09-02', sex: 'MALE', barangay: 'San Juan', purok: 'Purok 4', contact: null },
    b: { first: 'Wilfredo  ', middle: 'Castillo', last: ' Macatangay', dob: '1975-09-02', sex: 'MALE', barangay: 'San Juan', purok: 'Purok 4', contact: null },
    note: 'Extra spaces in the encoded name.',
  },
  {
    a: { first: 'Rowena', middle: 'Padilla', last: 'Gumabao', dob: '1988-12-12', sex: 'FEMALE', barangay: 'Santa Cruz', purok: 'Sitio Ilawod', contact: '09205556666' },
    b: { first: 'Rowena', middle: null, last: 'Gumabao', dob: '1988-12-12', sex: 'FEMALE', barangay: 'Santa Cruz', purok: 'Sitio Ilawod', contact: '09205556666' },
    note: 'Middle name missing on the second encoding.',
  },
  {
    a: { first: 'Jhun', middle: 'Ocampo', last: 'Tolentino', dob: '1994-06-27', sex: 'MALE', barangay: 'San Miguel', purok: 'Purok 6', contact: '09176667777' },
    b: { first: 'Jun', middle: 'Ocampo', last: 'Tolentino', dob: '1994-06-27', sex: 'MALE', barangay: 'San Miguel', purok: 'Purok 6', contact: null },
    note: 'First-name spelling variation (Jhun / Jun).',
  },
  {
    a: { first: 'Bernadette', middle: 'Salvador', last: 'Albao', dob: '1999-02-08', sex: 'FEMALE', barangay: 'Sagrada Familia', purok: 'Purok 2', contact: null },
    b: { first: 'Bernadette', middle: 'Salvador', last: 'Albao', dob: null, sex: 'FEMALE', barangay: 'Sagrada Familia', purok: 'Purok 2', contact: null },
    note: 'Birthdate missing on the second encoding — needs verification, not automatic merging.',
  },
]
const spread = (v) => ({
  first_name: v.first, middle_name: v.middle, last_name: v.last, suffix: null,
  date_of_birth: v.dob, sex: v.sex, contact_number: v.contact ?? null,
  purok: v.purok, barangay: v.barangay,
  address: `${v.purok}, ${v.barangay}, Nabua, Camarines Sur`,
})
for (const c of nearCases) {
  const a = addPerson({ ...spread(c.a), civil_status: 'MARRIED', status: 'ACTIVE', created_days_ago: int(200, 520) })
  const b = addPerson({ ...spread(c.b), civil_status: 'MARRIED', status: 'FOR_REVIEW', created_days_ago: int(2, 90),
    remarks: 'Flagged during encoding: possible duplicate of an existing master record.' })
  duplicateCases.push({
    a: a.id, b: b.id, score: c.b.first_name === 'Jhun' ? 93 : c.b.middle_name === null ? 92 : 98,
    band: 'POSSIBLE', status: 'PENDING', source: 'LIVE_CHECK',
    fields: ['last_name', 'first_name', 'date_of_birth', 'sex', 'barangay'], notes: c.note,
  })
}

/** Case C: same name but a DIFFERENT birthdate — must NOT be auto-classified as
 *  the same person; shown as a potential match for a human decision. */
const differentPeople = [
  {
    a: { first: 'Antonio', middle: 'Rivera', last: 'Fernandez', dob: '1965-04-14', sex: 'MALE', barangay: 'San Rafael', purok: 'Purok 5' },
    b: { first: 'Antonio', middle: 'Rivera', last: 'Fernandez', dob: '1971-08-30', sex: 'MALE', barangay: 'San Rafael', purok: 'Purok 5' },
    note: 'Same name, different birthdate — likely father and son.',
  },
  {
    a: { first: 'Cristina', middle: 'Domingo', last: 'Isidro', dob: '1983-01-05', sex: 'FEMALE', barangay: 'Sto. Domingo', purok: 'Purok 3' },
    b: { first: 'Cristina', middle: 'Domingo', last: 'Isidro', dob: '1983-01-05', sex: 'FEMALE', barangay: 'San Pedro', purok: 'Purok 1' },
    note: 'Same name and birthdate but different barangay — verify residency before merging.',
  },
  {
    a: { first: 'Rene', middle: 'Velasco', last: 'Cordial', dob: '2001-10-19', sex: 'MALE', barangay: 'San Nicolas', purok: 'Sitio Balongay' },
    b: { first: 'Rene', middle: null, last: 'Cordial', dob: '2001-10-19', sex: 'MALE', barangay: 'San Nicolas', purok: 'Purok 2' },
    note: 'Same name and birthdate, no middle name on record B — check with the household.',
  },
]
for (const c of differentPeople) {
  const a = addPerson({ ...spread(c.a), civil_status: 'MARRIED', status: 'FOR_REVIEW', created_days_ago: int(300, 700) })
  const b = addPerson({ ...spread(c.b), civil_status: 'MARRIED', status: 'FOR_REVIEW', created_days_ago: int(1, 45),
    remarks: 'Possible duplicate raised during encoding.' })
  duplicateCases.push({
    a: a.id, b: b.id, score: c.b.barangay !== c.a.barangay ? 74 : c.b.middle_name === null ? 71 : 68,
    band: 'POTENTIAL', status: 'PENDING', source: 'MANUAL', fields: ['last_name', 'first_name'], notes: c.note,
  })
}

// ---------------------------------------------------------------- resolved cases (history)
const resolved = [
  { a: 1, b: 2, status: 'DIFFERENT_PERSON', resolution: 'DIFFERENT_PERSON', notes: 'Household interview confirmed two different residents.' },
  { a: 3, b: 4, status: 'MERGED', resolution: 'MERGED', notes: 'Same person encoded twice by two encoders.' },
  { a: 5, b: 6, status: 'KEPT_BOTH', resolution: 'KEEP_BOTH', notes: 'Siblings with identical names; both retained deliberately.' },
  { a: 7, b: 8, status: 'DEFERRED', resolution: 'DEFER', notes: 'Waiting for the barangay secretary to confirm residency.' },
]
resolved.forEach((r, i) => {
  const a = persons[r.a % persons.length]
  const b = persons[(r.b + 10) % persons.length]
  if (!a || !b || a.id === b.id) return
  duplicateCases.push({
    a: a.id, b: b.id, score: 70 + i * 6, band: i % 2 ? 'POSSIBLE' : 'POTENTIAL',
    status: r.status, source: 'MANUAL', fields: ['last_name', 'first_name'],
    notes: r.notes, resolution: r.resolution,
    reviewed_days_ago: int(1, 60), reviewed_by: i % 2 ? 'Maria Santos' : 'Josefina Ramos',
  })
})

// ---------------------------------------------------------------- transfer history sample
const transferSamples = [
  { personIndex: 0, from: 'San Isidro', to: 'San Roque', reason: 'RESIDENT_TRANSFER', fromDays: 400, toDays: 120, notes: 'Family relocated to San Roque.' },
  { personIndex: 3, from: 'San Juan', to: 'Santa Cruz', reason: 'RESIDENT_TRANSFER', fromDays: 620, toDays: 210, notes: 'Moved after marriage.' },
  { personIndex: 8, from: 'San Miguel', to: 'La Purisima', reason: 'ADMINISTRATIVE_CORRECTION', fromDays: 300, toDays: 30, notes: 'Corrected barangay assignment — encoded to the wrong barangay.' },
]

// ---------------------------------------------------------------- export
// ---------------------------------------------------------------- legacy duplicate keys
// Real registries carry duplicates that were encoded before the guard existed.
// The demonstration data keeps them (they are the whole point of the Duplicate
// Centre) but every stored row must still satisfy the unique identity index —
// exactly like the database guard does for a verified namesake, later occurences
// receive a '#n' discriminator and lose the automatic identity lock.
const normKey = (p) =>
  [
    (p.last_name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(),
    (p.first_name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(),
    (p.middle_name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(),
    (p.suffix || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(),
    p.date_of_birth || '',
  ].join('|')

const seenKeys = new Map()
let legacyDuplicates = 0
for (const p of persons) {
  const key = normKey(p)
  const n = (seenKeys.get(key) ?? 0) + 1
  seenKeys.set(key, n)
  if (n === 1) {
    if (!p.identity_key) p.identity_key = key
  } else {
    p.identity_key = `${key}#${n}`
    p.identity_lock = false
    if (p.status === 'ACTIVE') p.status = 'FOR_REVIEW'
    legacyDuplicates++
  }
}
console.log(`  · ${legacyDuplicates} legacy duplicate row(s) given identity discriminators`)

// ---------------------------------------------------------------- validation
const broken = persons.filter((p) => !p.first_name || !p.last_name || !p.barangay)
if (broken.length) {
  console.error('✗ seed validation failed for:', broken.slice(0, 3))
  process.exit(1)
}

const seed = {
  generated_at: new Date().toISOString(),
  municipality: 'Nabua',
  province: 'Camarines Sur',
  barangays: BARANGAYS,
  // The published bundle must never carry usable demonstration passwords:
  // seed.json ships the salted hash the on-device registry verifies against,
  // exactly as src/lib/localApi.ts computes it (SALT:email:password).
  users: USERS.map(({ password, ...u }) => ({
    ...u,
    password_hash: createHash('sha256').update(`nmbr-local-demo-salt:${u.email}:${password}`).digest('hex'),
  })),
  households: householdPool.slice(0, 12),
  persons,
  duplicate_cases: duplicateCases,
  transfers: transferSamples,
}

mkdirSync(join(root, 'src', 'data'), { recursive: true })
writeFileSync(join(root, 'src', 'data', 'seed.json'), JSON.stringify(seed, null, 1))
console.log(`✓ src/data/seed.json — ${persons.length} members, ${duplicateCases.length} duplicate cases`)

// ---------------------------------------------------------------- SQL
const esc = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const escNull = (v) => (v === null || v === undefined || v === '' ? 'null' : esc(v))

function personRow(p) {
  const created = `now() - interval '${p.created_days_ago} days'`
  const updated = `now() - interval '${p.updated_days_ago} days'`
  return `(${esc(p.reference_no)}, ${esc(p.first_name)}, ${escNull(p.middle_name)}, ${esc(p.last_name)}, ${escNull(p.suffix)},
    ${p.date_of_birth ? `date ${esc(p.date_of_birth)}` : 'null'}, ${escNull(p.sex)}, ${escNull(p.civil_status)},
    ${escNull(p.contact_number)}, ${escNull(p.address)}, ${escNull(p.purok)}, ${esc(p.barangay)},
    ${esc(p.status)}, ${escNull(p.remarks)}, ${esc(p.identity_key || '')}, ${p.identity_lock ? 'true' : 'false'},
    ${esc(p.encodedBy)}, ${created}, ${updated})`
}

const sql = []
sql.push(`-- =====================================================================
-- NMBR — supabase/seed.sql
-- FICTIONAL demonstration dataset for Nabua, Camarines Sur.
-- Run AFTER the migrations, in the Supabase SQL editor.
--   • ${BARANGAYS.length} barangays
--   • ${persons.length} master person records
--   • ${duplicateCases.length} duplicate cases (pending + resolved)
-- Re-running is safe: it skips rows that already exist.
-- =====================================================================

-- 1. Barangays
insert into barangays (name, municipality, province, district)
values
${BARANGAYS.map((b) => `  (${esc(b.name)}, 'Nabua', 'Camarines Sur', ${esc(b.district)})`).join(',\n')}
on conflict (municipality, name) do nothing;

-- 2. Staff accounts (profiles only).
--    Supabase Auth accounts are created separately — see supabase/PROVISION_USERS.sql
insert into users (name, email, role)
values
${USERS.map((u) => `  (${esc(u.name)}, ${esc(u.email)}, ${esc(u.role)})`).join(',\n')}
on conflict (email) do nothing;

-- 3. Households
insert into households (household_no, barangay_id, purok, address)
select v.no, b.id, v.purok, v.purok || ', ' || b.name || ', Nabua, Camarines Sur'
from (values
${seed.households.map((h) => `  (${esc(h.household_no)}, ${esc(h.barangay)}, ${esc(pick(PUROKS))})`).join(',\n')}
) as v(no, barangay, purok)
join barangays b on b.name = v.barangay
on conflict (household_no) do nothing;

-- 4. Master person records.
--    identity_lock = false keeps the exact demonstration identity keys, including
--    the "#2" discriminators that represent verified namesakes.
insert into persons (
  reference_no, first_name, middle_name, last_name, suffix, date_of_birth, sex, civil_status,
  contact_number, address, purok, barangay_id, status, remarks, identity_key, identity_lock,
  created_by, created_at, updated_at)
select v.reference_no, v.first_name, v.middle_name, v.last_name, v.suffix, v.date_of_birth, v.sex,
       v.civil_status, v.contact_number, v.address, v.purok, b.id, v.status::person_status, v.remarks,
       v.identity_key, v.identity_lock, u.id, v.created_at, v.updated_at
from (values
${persons.map((p) => '  ' + personRow(p)).join(',\n')}
) as v(reference_no, first_name, middle_name, last_name, suffix, date_of_birth, sex, civil_status,
       contact_number, address, purok, barangay_name, status, remarks, identity_key, identity_lock,
       encoder_email, created_at, updated_at)
join barangays b on b.name = v.barangay_name
left join users u on u.email = v.encoder_email
where not exists (select 1 from persons p where p.reference_no = v.reference_no);

-- 5. Current barangay history for every member
insert into member_barangay_history (person_id, barangay_id, effective_from, status, reason)
select p.id, p.barangay_id, p.created_at::date, 'ACTIVE', null
from persons p
where p.barangay_id is not null
  and not exists (select 1 from member_barangay_history h where h.person_id = p.id);

-- 6. Sample transfers — a person keeps ONE master record while the barangay changes
${transferSamples.map((t, i) => {
  const who = persons[t.personIndex]
  return `-- transfer ${i + 1}: ${who.first_name} ${who.last_name} — ${t.from} → ${t.to} (${t.reason})
update member_barangay_history h
   set effective_to = greatest(current_date - interval '${t.toDays} days', effective_from),
       status = 'ENDED'
 where h.person_id = (select id from persons where reference_no = ${esc(who.reference_no)})
   and h.effective_to is null;

insert into member_barangay_history (person_id, barangay_id, effective_from, status, reason, notes)
select p.id, b.id, current_date - interval '${t.toDays} days', 'ACTIVE', ${esc(t.reason)}, ${esc(t.notes)}
from persons p, barangays b
where p.reference_no = ${esc(who.reference_no)} and b.name = ${esc(t.to)};

update persons set barangay_id = (select id from barangays where name = ${esc(t.to)})
 where reference_no = ${esc(who.reference_no)};
`
}).join('\n')}
-- 7. Duplicate cases (pending and resolved history)
insert into duplicate_cases (person_id_a, person_id_b, match_score, match_band, matching_fields,
                             status, source, notes, resolution, reviewed_by_name, reviewed_at)
select a.id, b.id, v.score, v.band::match_band, v.fields, v.status::duplicate_status, v.source,
       v.notes, v.resolution, v.reviewed_by,
       case when v.reviewed_days_ago is null then null else now() - (v.reviewed_days_ago || ' days')::interval end
from (values
${duplicateCases.map((c) => `  (${esc(persons.find((p) => p.id === c.a).reference_no)}, ${esc(persons.find((p) => p.id === c.b).reference_no)}, ${c.score}, ${esc(c.band)}, ${esc('{' + (c.fields || []).join(',') + '}')}::text[], ${esc(c.status)}, ${esc(c.source || 'MANUAL')}, ${esc(c.notes)}, ${escNull(c.resolution)}, ${escNull(c.reviewed_by)}, ${c.reviewed_days_ago ?? 'null'})`).join(',\n')}
) as v(ref_a, ref_b, score, band, fields, status, source, notes, resolution, reviewed_by, reviewed_days_ago)
join persons a on a.reference_no = v.ref_a
join persons b on b.reference_no = v.ref_b
on conflict do nothing;

-- 8. Opening audit trail
insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_label, reason, new_values, session_info, timestamp)
select u.id, u.name, u.role, 'IMPORTED', 'IMPORT_BATCH', 'nmbr_demo_dataset.csv',
       'Initial municipal registry load', jsonb_build_object('imported', ${persons.length}), fn_session_info(),
       now() - interval '30 days'
from users u where u.email = 'admin@nabua.gov.ph';
`)

writeFileSync(join(root, 'supabase', 'seed.sql'), sql.join('\n'))
console.log(`✓ supabase/seed.sql — ${persons.length} members, ${duplicateCases.length} duplicate cases`)
