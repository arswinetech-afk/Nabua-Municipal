/**
 * OFFLINE RE-SIGN-IN VERIFIER.
 *
 * Why this exists: the registry is offline-first, and office phones in the
 * field lose the link regularly. A session expires after a period of
 * inactivity, and before this verifier the only accounts that could sign in
 * again without a connection were the built-in demonstration accounts — a
 * live deployment with the demonstration seed switched off would lock an
 * encoder out of their own phone until the signal returned.
 *
 * How it works: when a sign-in is accepted by the municipal server, a salted
 * PBKDF2 verifier of the password (never the password itself) is kept on the
 * device, keyed by email. The on-device registry can then confirm a later
 * offline sign-in for that same account and restore the cached profile
 * (name, role, barangay scope) so encoding can continue; everything written
 * still queues and still needs the server session to upload.
 *
 * Security notes:
 *   • The verifier is a one-way PBKDF2-SHA256 digest (120 000 iterations) with
 *     a per-account random salt; it cannot be reversed into the password.
 *   • It only ever confirms an account that already signed in successfully on
 *     this device while online — it never grants access to a new account.
 *   • A stolen device still needs the office password to pass the verifier,
 *     and the server remains the only place where data can be uploaded.
 *     Device screen locks are still recommended (see docs/GO_LIVE.md).
 *   • It is rewritten on every successful online sign-in, so a password change
 *     made on the server invalidates the old verifier the next time the
 *     account signs in online, and a deactivated account is forgotten as soon
 *     as the server reports it.
 */
import type { SessionUser } from './api'

const STORE_KEY = 'nmbr.offlinecred.v1'
const ITERATIONS = 120_000

type StoredCredential = {
  email: string
  user: SessionUser
  salt: string
  hash: string
  saved_at: number
}

function readStore(): Record<string, StoredCredential> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, StoredCredential>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, StoredCredential>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch {
    /* a full device must not break sign-in */
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** PBKDF2-SHA256 of the password with the stored salt; deterministic per device. */
async function deriveHex(password: string, saltHex: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    // Non-cryptographic fallback (test runners without WebCrypto): still
    // deterministic, so verify() remains consistent within one environment.
    let h = 0
    const input = `${saltHex}:${password}`
    for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0
    return `fallback${h}`
  }
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex) as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    key, 256,
  )
  return toHex(bits)
}

function randomSaltHex(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Remember a verifier for an account the municipal server just authenticated. */
export async function rememberOfflineCredential(user: SessionUser, password: string): Promise<void> {
  if (!user?.email || !password) return
  const salt = randomSaltHex()
  const hash = await deriveHex(password, salt)
  const store = readStore()
  store[user.email.trim().toLowerCase()] = {
    email: user.email.trim().toLowerCase(), user, salt, hash, saved_at: Date.now(),
  }
  writeStore(store)
}

/**
 * Confirm an offline sign-in for an account previously authenticated online on
 * this device. Returns the cached profile when the password matches.
 */
export async function verifyOfflineCredential(email: string, password: string): Promise<SessionUser | null> {
  const entry = readStore()[email.trim().toLowerCase()]
  if (!entry) return null
  const hash = await deriveHex(password, entry.salt)
  if (hash !== entry.hash) return null
  return { ...entry.user }
}

/** Drop the verifier (server reported the account deactivated or removed). */
export function forgetOfflineCredential(email: string): void {
  const store = readStore()
  delete store[email.trim().toLowerCase()]
  writeStore(store)
}
