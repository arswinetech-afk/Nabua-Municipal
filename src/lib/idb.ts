/**
 * IndexedDB backing for the persons mirror.
 *
 * localStorage is capped at roughly 5 MB per origin: a municipality-scale
 * registry (40 000 members ≈ 16 MB of mirror JSON) can never fit there, and
 * re-serialising it on every save stalls the UI. IndexedDB quotas are
 * disk-based (hundreds of MB), so the mirror lives here while sessions,
 * the outbox, audit and settings — all tiny — stay in localStorage.
 *
 * Environments without IndexedDB (older browsers, some test runners) fall
 * back to the old localStorage path, quota warning included.
 */
const DB_NAME = 'nmbr-store'
const STORE = 'kv'

export function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

/** Close the cached handle (tests delete the database between cases). */
export async function idbClose(): Promise<void> {
  const db = dbPromise ? await dbPromise : null
  db?.close()
  dbPromise = null
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

export async function idbSet(key: string, value: unknown): Promise<boolean> {
  const db = await open()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}
