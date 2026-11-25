import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/spectral/latin-500.css'
import '@fontsource/spectral/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './katex.css'
import './index.css'
import App from './App'
import { countVisit } from './visit'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

// Offline support and installing as an app. Not in embedded previews or the single-file build.
const topWindow = (() => { try { return window.self === window.top } catch { return false } })()
if (import.meta.env.PROD && import.meta.env.MODE !== 'single' && topWindow && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

// Anonymous once-a-day visit count (see visit.ts). Not in embedded previews or the single-file build.
if (import.meta.env.PROD && import.meta.env.MODE !== 'single' && topWindow) {
  window.addEventListener('load', () => setTimeout(countVisit, 2000))
}
