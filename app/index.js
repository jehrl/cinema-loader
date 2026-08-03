const fs = require('fs')
const path = require('path')

const configPath = fs.existsSync(path.join(__dirname, 'config.json'))
  ? './config.json'
  : './default.config.json'
const configs = require(configPath)
const statePath = process.env.WATCH_STATE_PATH
  ? path.resolve(process.env.WATCH_STATE_PATH)
  : path.join(__dirname, '.watch-state.json')
const dryRun = process.env.DRY_RUN === '1'
const runOnce = process.env.RUN_ONCE === '1'

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return {}
  }
}

const saveState = state => {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds))

const isoDates = (startDate, endDate) => {
  const dates = []
  const current = new Date(`${startDate}T12:00:00Z`)
  const end = new Date(`${endDate}T12:00:00Z`)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

const urlsFor = config => {
  if (!config.url.includes('YYYY-MM-DD')) return [config.url]

  if (!config.startDate || !config.endDate) {
    throw new Error('URL with YYYY-MM-DD requires startDate and endDate')
  }

  return isoDates(config.startDate, config.endDate).map(date =>
    config.url.replace('YYYY-MM-DD', date)
  )
}

const downloadJson = async url => {
  let lastError

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'cinema-loader/0.2 (+https://github.com/ra100/cinema-loader)' },
        signal: AbortSignal.timeout(15000)
      })

      if (!response.ok) {
        throw new Error(`Cinema City returned HTTP ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < 3) await delay(attempt * 2000)
    }
  }

  throw lastError
}

const matches = (config, event) => {
  if (config.filmId && event.filmId !== config.filmId) return false

  const attributes = new Set(event.attributeIds || [])
  return (config.requiredAttributeIds || []).every(attribute =>
    attributes.has(attribute)
  )
}

const loadEvents = async config => {
  const responses = await Promise.all(urlsFor(config).map(downloadJson))
  const events = responses.flatMap(data => data?.body?.events || [])

  return events
    .filter(event => matches(config, event))
    .sort((left, right) => left.eventDateTime.localeCompare(right.eventDateTime))
}

const bookingLink = event =>
  event.bookingRouterLaunchLink ||
  event.bookingLink?.replace('/api/order/', '/order/') ||
  null

const eventDescription = event => {
  const timestamp = new Date(event.eventDateTime)
  const date = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    weekday: 'short',
    day: 'numeric',
    month: 'numeric'
  }).format(timestamp)
  const time = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp)

  return `${date} ${time}`
}

const ntfyNotification = async (config, title, message, newEvents) => {
  const server = process.env.NTFY_SERVER || config.ntfyServer || 'https://ntfy.sh'
  const topic = process.env.NTFY_TOPIC || config.ntfyTopic
  const token = process.env.NTFY_TOKEN || config.ntfyToken

  if (!topic) throw new Error('NTFY_TOPIC is not configured')

  const details = newEvents.map(event => {
    const link = bookingLink(event)
    return `${eventDescription(event)}${link ? ` ${link}` : ''}`
  })
  const response = await fetch(server.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      topic,
      title,
      message: `${message}\n\n${details.join('\n')}`,
      priority: 5,
      tags: ['ticket', 'movie_camera'],
      click: bookingLink(newEvents[0]) || config.cinemaLink
    }),
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`ntfy notification failed (${response.status}): ${details}`)
  }
}

const sendNotification = async (config, newEvents) => {
  const descriptions = newEvents.map(eventDescription)
  const title = config.notificationTitle || 'Cinema City – nový program'
  const message = descriptions.join(', ')
  console.log(`[${new Date().toISOString()}] ${title}: ${message}`)
  for (const event of newEvents) {
    console.log(`  ${eventDescription(event)} ${bookingLink(event) || ''}`)
  }

  if (dryRun) return
  await ntfyNotification(config, title, message, newEvents)
}

const watch = async config => {
  const state = loadState()
  const watchId = config.id || config.url
  const knownIds = new Set(state[watchId] || [])
  let lastPing = 0

  console.log(`[${new Date().toISOString()}] Watching ${watchId}`)

  while (true) {
    try {
      const events = await loadEvents(config)
      const newEvents = events.filter(event => !knownIds.has(String(event.id)))

      if (newEvents.length) {
        await sendNotification(config, newEvents)
        events.forEach(event => knownIds.add(String(event.id)))
        state[watchId] = [...knownIds]
        if (!dryRun) saveState(state)

        if (config.exitAfterNotification) return
      }

      const now = Date.now()
      if (config.pingInterval && now - lastPing >= config.pingInterval * 1000) {
        console.log(`[${new Date().toISOString()}] Watchdog is running; no new matching sessions.`)
        lastPing = now
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Check failed:`, error.message)
      if (runOnce) throw error
    }

    if (runOnce) return
    await delay(config.refreshInterval * 1000)
  }
}

const resolvedConfigs = configs.map(config => ({
  ...config,
  startDate: process.env.WATCH_START_DATE || config.startDate,
  endDate: process.env.WATCH_END_DATE || config.endDate
}))

Promise.all(resolvedConfigs.map(watch)).catch(error => {
  console.error(error)
  process.exitCode = 1
})
