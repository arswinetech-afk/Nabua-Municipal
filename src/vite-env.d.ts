/// <reference types="vite/client" />

/**
 * Build stamp injected by Vite (see `define` in vite.config.ts). Shown in
 * Settings so a support call can tell at a glance which build a device is
 * running — the difference between “the fix is not deployed” and “this phone
 * is still holding an older cached build”.
 */
declare const __NMBR_BUILD__: string
