// Anonymous visit count for https://kagitha.com/api/stats. Sends {"app":"markdown"} to kagitha.com at
// most once per browser per day. No cookies, no IDs, and nothing about the files you open.
//
// The request is a text/plain POST with credentials omitted, so browsers send it cross-site without a
// CORS preflight; kagitha.com also answers with Access-Control-Allow-Origin for this site.
const ENDPOINT = 'https://kagitha.com/api/app-visit'
const KEY = 'kagitha-visit-day'

export function countVisit() {
  if (location.hostname !== 'markdown.kagitha.com' || !navigator.onLine) return
  const today = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in the visitor's time zone
  try {
    if (localStorage.getItem(KEY) === today) return
    localStorage.setItem(KEY, today)
  } catch {
    return // storage blocked: skip rather than count every page load
  }
  fetch(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ app: 'markdown' }),
    headers: { 'Content-Type': 'text/plain' },
    mode: 'cors',
    credentials: 'omit',
    keepalive: true,
  }).catch(() => {})
}
