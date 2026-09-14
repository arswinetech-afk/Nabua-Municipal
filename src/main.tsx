import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { ToastProvider } from './components/ui'
import { AppProvider } from './state/AppProvider'
import { getApi } from './lib/apiClient'

/**
 * Touch the API client during boot: this loads (or seeds) the local registry
 * mirror, so an encoder who opens the app with no connection still sees the
 * full member list instead of an empty screen.
 */
getApi()

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
