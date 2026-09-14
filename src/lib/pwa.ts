/**
 * Keeping an installed copy of NMBR current.
 *
 * The application is a PWA: once it is installed on a phone or left open in a
 * browser, the service worker keeps serving the build that was cached when it
 * was last loaded. A bug fixed and redeployed on the server can therefore stay
 * on the device for weeks — which is exactly what happened with the dialog
 * focus defect, where the field kept losing the caret on a phone that was still
 * running an older build.
 *
 * The service worker is generated with `autoUpdate`, so a new build takes
 * control on its own. What is missing is a *signal*: the page that is already
 * open is still running the old JavaScript. This module watches for that moment
 * and offers the user a reload, rather than reloading behind their back while
 * they may be midway through a form.
 */
import { useEffect, useState } from 'react'

const BUILD_KEY = 'nmbr.build'

/** Which build this bundle is; injected by Vite at build time. */
export const APP_BUILD: string = typeof __NMBR_BUILD__ === 'string' ? __NMBR_BUILD__ : 'development'

let listening = false
let updateReady = false
const listeners = new Set<(ready: boolean) => void>()

function announce(ready: boolean) {
  updateReady = ready
  listeners.forEach((l) => l(ready))
}

/** The build the running page was loaded from, recorded so staleness is visible. */
export function recordBuild(buildId: string = APP_BUILD): void {
  try {
    localStorage.setItem(BUILD_KEY, buildId)
  } catch {
    /* private browsing: nothing to record, the app still works */
  }
}

/**
 * Start watching for a newer build. Called once from the application entry point.
 * Safe to call repeatedly and safe in environments without service workers
 * (the tests, old browsers).
 */
export function watchForAppUpdates(): void {
  if (listening) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  listening = true

  // On a first visit there is no worker in control yet. A worker taking over
  // then is normal startup, not an update, and must never trigger a reload.
  const hadController = Boolean(navigator.serviceWorker.controller)

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return
    announce(true)
  })

  const check = () => {
    void navigator.serviceWorker.ready
      .then((reg) => reg.update())
      .catch(() => undefined)
  }

  const onVisible = () => {
    // A staff member returning to the app after lunch is the most likely moment
    // for a new build to have been deployed.
    if (document.visibilityState === 'visible') check()
  }

  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', check)
  window.setInterval(check, 30 * 60 * 1000)
  // One check shortly after opening, once the first paint has happened.
  window.setTimeout(check, 5_000)
}

export function appUpdateReady(): boolean {
  return updateReady
}

/** Load the new build. The user asked for it, so a reload here is expected. */
export function applyAppUpdate(): void {
  window.location.reload()
}

/** Subscribe a component to the “a newer version is ready” signal. */
export function useAppUpdate(): boolean {
  const [ready, setReady] = useState(appUpdateReady)
  useEffect(() => {
    const listener = (value: boolean) => setReady(value)
    listeners.add(listener)
    listener(appUpdateReady())
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return ready
}
