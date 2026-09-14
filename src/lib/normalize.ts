/**
 * Text / name normalisation utilities.
 *
 * IMPORTANT: this file is the canonical client-side implementation of the
 * normalisation rules used by the database (see supabase/migrations/0002_functions.sql).
 * Any change here MUST be mirrored in SQL so that identity keys stay identical
 * between the browser (offline duplicate checking) and PostgreSQL (hard guard).
 */

/** Remove diacritics (José -> Jose, Peña -> Pena). */
export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Uppercase, strip punctuation, collapse all whitespace. Used for free text. */
export function normalizeText(input?: string | null): string {
  if (!input) return ''
  return stripDiacritics(String(input))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Same as normalizeText — kept separate for readability at call sites. */
export function normalizeName(input?: string | null): string {
  return normalizeText(input)
}

/** Digits only (for contact numbers / reference numbers). */
export function normalizeDigits(input?: string | null): string {
  if (!input) return ''
  return String(input).replace(/\D+/g, '')
}

/** Normalise a phone number to a comparable national form (PH). */
export function normalizeContact(input?: string | null): string {
  let d = normalizeDigits(input)
  if (!d) return ''
  if (d.startsWith('63') && d.length > 10) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  return d
}

/** ISO date (YYYY-MM-DD) or '' */
export function normalizeDate(input?: string | Date | null): string {
  if (!input) return ''
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return ''
    return input.toISOString().slice(0, 10)
  }
  const s = String(input).trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // PH-friendly formats: 01/12/1985, 1-12-1985, Jan 12 1985
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (m) {
    let [, a, b, y] = m
    let year = Number(y)
    if (year < 100) year += year > 30 ? 1900 : 2000
    let month = Number(a)
    let day = Number(b)
    if (month > 12 && day <= 12) [month, day] = [day, month]
    if (month < 1 || month > 12 || day < 1 || day > 31) return ''
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return ''
}

/** Character bigrams (mirrors PostgreSQL pg_trgm behaviour for short strings). */
function bigrams(s: string): string[] {
  const padded = `  ${s} `
  const out: string[] = []
  for (let i = 0; i < padded.length - 1; i++) out.push(padded.slice(i, i + 2))
  return out
}

/** Dice coefficient over character bigrams — same family as pg_trgm's similarity(). */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  const map = new Map<string, number>()
  for (const g of A) map.set(g, (map.get(g) ?? 0) + 1)
  let matches = 0
  for (const g of B) {
    const c = map.get(g) ?? 0
    if (c > 0) {
      matches++
      map.set(g, c - 1)
    }
  }
  if (!A.length || !B.length) return 0
  return (2 * matches) / (A.length + B.length)
}

/** Token (word) set similarity with a containment bonus: "JUAN CRUZ" vs "JUAN SANTOS CRUZ". */
export function tokenSetSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = new Set(a.split(' ').filter(Boolean))
  const B = new Set(b.split(' ').filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  const jaccard = inter / union
  // Every token of the shorter string appears in the longer one -> strong signal.
  const containment = inter === Math.min(A.size, B.size) ? 0.85 : 0
  return Math.max(jaccard, containment)
}

/** Lightweight soundex-style key (mirrors PostgreSQL fuzzystrmatch dmetaphone family). */
function phoneticKey(s: string): string {
  const words = s.split(' ').filter(Boolean)
  return words
    .map((w) => {
      let x = w
        .replace(/^(KN|GN|PN|WR|PS)/, (m) => m[1])
        .replace(/X/, 'S')
        .replace(/CQ|CE|CI|CY/, 'S')
        .replace(/PH/, 'F')
        .replace(/GH/, 'H')
        .replace(/TH/, '0')
        .replace(/[AEIOUY]/g, '')
        .replace(/(.)\1+/g, '$1')
      return x.slice(0, 4)
    })
    .filter(Boolean)
    .join('')
}

/**
 * Similarity for a single name field. Combines character trigram similarity,
 * token-set similarity and a phonetic comparison (catches TYPO-class matches
 * such as "Jhun" vs "Jun", "Cruz" vs "Cruzz").
 */
export function nameFieldSimilarity(a?: string | null, b?: string | null): { score: number; reason: string } {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return { score: 0.5, reason: 'unknown' }
  if (x === y) return { score: 1, reason: 'exact' }
  const tri = trigramSimilarity(x, y)
  const tok = tokenSetSimilarity(x, y)
  let score = Math.max(tri, tok)
  if (score < 0.92 && phoneticKey(x) && phoneticKey(x) === phoneticKey(y)) {
    score = Math.max(score, 0.88)
    return { score, reason: 'phonetic' }
  }
  if (score >= 0.9) return { score, reason: 'near' }
  if (score >= 0.72) return { score, reason: 'partial' }
  return { score, reason: score >= 0.5 ? 'weak' : 'mismatch' }
}

/** Canonical identity key. MUST match fn_identity_key() in SQL. */
export function identityKey(p: {
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  suffix?: string | null
  date_of_birth?: string | null
}): string {
  const last = normalizeName(p.last_name)
  const first = normalizeName(p.first_name)
  const middle = normalizeName(p.middle_name)
  const suffix = normalizeName(p.suffix)
  const dob = normalizeDate(p.date_of_birth)
  return `${last}|${first}|${middle}|${suffix}|${dob}`
}

export function fullName(p: {
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  suffix?: string | null
}): string {
  const parts = [p.first_name, p.middle_name, p.last_name].filter(Boolean) as string[]
  let name = parts.join(' ')
  if (p.suffix) name += ` ${p.suffix}`
  return name.replace(/\s+/g, ' ').trim()
}

/** "1234" -> "•••• 1234" style masking for list/search screens. */
export function maskContact(contact?: string | null): string {
  const d = normalizeDigits(contact)
  if (!d) return '—'
  if (d.length <= 4) return d
  return `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`
}
