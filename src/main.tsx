import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { ToastProvider } from './components/ui'
import { AppProvider } from './state/AppProvider'
import { getApi } from './lib/apiClient'
import { recordBuild, watchForAppUpdates } from './lib/pwa'

/**
 * Touch the API client during boot: this loads (or seeds) the local registry
 * mirror, so an encoder who opens the app with no connection still sees the
 * full member list instead of an empty screen.
 */
getApi()

// Note which build this device is running, and offer a reload when the server
// has a newer one (an installed copy otherwise keeps the old build for weeks).
recordBuild()
watchForAppUpdates()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
