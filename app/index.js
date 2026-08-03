const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const DEFAULT_FETCH_CONCURRENCY = 4
const MAX_EVENTS_PER_NOTIFICATION = 8

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds))

const parseIsoDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error(`Invalid ISO date: ${value}`)
  }

  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO date: ${value}`)
  }
  return date
}

const isoDates = (startDate, endDate) => {
  const dates = []
  const current = parseIsoDate(startDate)
  const end = parseIsoDate(endDate)

  if (current > end) {
    throw new Error(`startDate ${startDate} is after endDate ${endDate}`)
  }

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
    config.url.replaceAll('YYYY-MM-DD', date)
  )
}

const validateConfig = (config, options = {}) => {
  if (!config || typeof config !== 'object') throw new Error('Invalid config entry')
  if (!config.url || typeof config.url !== 'string') throw new Error('Config requires url')
  if (!config.id && !config.url) throw new Error('Config requires id or url')
  urlsFor(config)

  if (!options.dryRun) {
    const topic = process.env.NTFY_TOPIC || config.ntfyTopic
    if (!topic) throw new Error('NTFY_TOPIC is not configured')
  }

  const server = process.env.NTFY_SERVER || config.ntfyServer || 'https://ntfy.sh'
  let parsedServer
  try {
    parsedServer = new URL(server)
  } catch {
    throw new Error(`Invalid ntfy server URL: ${server}`)
  }
  if (!['http:', 'https:'].includes(parsedServer.protocol)) {
    throw new Error(`Invalid ntfy server protocol: ${parsedServer.protocol}`)
  }

  if (!options.runOnce && (!Number.isFinite(config.refreshInterval) || config.refreshInterval <= 0)) {
    throw new Error('refreshInterval must be a positive number')
  }
}

const downloadJson = async (url, options = {}) => {
  const fetchImpl = options.fetchImpl || fetch
  const attempts = options.attempts || 3
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': 'cinema-loader/0.2 (+https://github.com/ra100/cinema-loader)' },
        signal: AbortSignal.timeout(options.timeoutMs || 15000)
      })

      if (!response.ok) {
        throw new Error(`Cinema City returned HTTP ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await delay(attempt * (options.retryDelayMs || 2000))
    }
  }

  throw lastError
}

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

const matches = (config, event) => {
  if (!event || typeof event !== 'object') return false
  if (config.filmId && event.filmId !== config.filmId) return false
  if (config.cinemaId && String(event.cinemaId) !== String(config.cinemaId)) return false
  if (config.auditoriumTinyName && event.auditoriumTinyName !== config.auditoriumTinyName) return false

  const attributes = new Set(event.attributeIds || [])
  return (config.requiredAttributeIds || []).every(attribute =>
    attributes.has(attribute)
  )
}

const loadEvents = async (config, options = {}) => {
  const urls = urlsFor(config)
  const responses = await mapWithConcurrency(
    urls,
    config.fetchConcurrency || DEFAULT_FETCH_CONCURRENCY,
    url => downloadJson(url, options)
  )

  const events = responses.flatMap((data, index) => {
    if (!data?.body || !Array.isArray(data.body.events)) {
      throw new Error(`Unexpected Cinema City response schema for ${urls[index]}`)
    }
    return data.body.events
  })

  const uniqueEvents = new Map()
  for (const event of events.filter(event => matches(config, event))) {
    if (event.id == null || !event.eventDateTime || !Array.isArray(event.attributeIds)) {
      throw new Error('Unexpected matching event schema from Cinema City')
    }
    uniqueEvents.set(eventFingerprint(event), event)
  }

  return [...uniqueEvents.values()].sort((left, right) =>
    String(left.eventDateTime).localeCompare(String(right.eventDateTime))
  )
}

const bookingLink = event =>
  event.bookingRouterLaunchLink ||
  event.bookingLink?.replace('/api/order/', '/order/') ||
  null

const eventFingerprint = event => {
  const identity = {
    id: String(event.id),
    eventDateTime: event.eventDateTime || null,
    cinemaId: event.cinemaId ? String(event.cinemaId) : null,
    auditorium: event.auditorium || null,
    auditoriumTinyName: event.auditoriumTinyName || null,
    attributeIds: [...(event.attributeIds || [])].sort()
  }
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

const eventDescription = event => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(event.eventDateTime || '')
  if (!match) {
    throw new Error(`Invalid eventDateTime for event ${event.id}`)
  }

  // Cinema City returns a Prague wall-clock time without a UTC offset. Parsing
  // it as a JavaScript Date would shift the displayed hour on GitHub's UTC
  // runners, so only the calendar part is parsed and the supplied time is kept.
  const timestamp = parseIsoDate(match[1])
  const date = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'numeric'
  }).format(timestamp)

  return `${date} ${match[2]}`
}

const chunksOf = (items, size) => {
  if (!Number.isInteger(size) || size <= 0) throw new Error('Chunk size must be positive')
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const ntfyNotification = async (config, title, events, options = {}) => {
  if (!events.length) throw new Error('Cannot send an empty notification')

  const fetchImpl = options.fetchImpl || fetch
  const server = process.env.NTFY_SERVER || config.ntfyServer || 'https://ntfy.sh'
  const topic = process.env.NTFY_TOPIC || config.ntfyTopic
  const token = process.env.NTFY_TOKEN || config.ntfyToken

  if (!topic) throw new Error('NTFY_TOPIC is not configured')

  const lines = events.map(event => {
    const link = bookingLink(event)
    return `${eventDescription(event)}${link ? ` ${link}` : ''}`
  })
  const response = await fetchImpl(server.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      topic,
      title,
      message: `${events.length} nových termínů:\n${lines.join('\n')}`,
      priority: 5,
      tags: ['ticket', 'movie_camera'],
      click: bookingLink(events[0]) || config.cinemaLink
    }),
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    const responseDetails = await response.text()
    throw new Error(`ntfy notification failed (${response.status}): ${responseDetails}`)
  }
}

const sendNotification = async (config, newEvents, options = {}) => {
  const baseTitle = config.notificationTitle || 'Cinema City – nový program'
  console.log(`[${new Date().toISOString()}] ${baseTitle}: ${newEvents.length} new session(s)`)
  for (const event of newEvents) {
    console.log(`  ${eventDescription(event)} ${bookingLink(event) || ''}`)
  }

  if (options.dryRun) return

  const chunks = chunksOf(newEvents, MAX_EVENTS_PER_NOTIFICATION)
  for (let index = 0; index < chunks.length; index++) {
    const suffix = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''
    await ntfyNotification(config, `${baseTitle}${suffix}`, chunks[index], options)
  }
}

const readWatchState = (state, watchId) => {
  const stored = state[watchId]
  if (Array.isArray(stored)) {
    return { fingerprints: new Set(), legacyIds: new Set(stored.map(String)), migrated: false }
  }

  return {
    fingerprints: new Set(stored?.fingerprints || []),
    legacyIds: new Set(stored?.legacyIds || []),
    migrated: false
  }
}

const writeWatchState = (state, watchId, watchState) => {
  state[watchId] = {
    version: 2,
    fingerprints: [...watchState.fingerprints].sort(),
    legacyIds: [...watchState.legacyIds].sort()
  }
}

const checkOnce = async (config, state, options = {}) => {
  const watchId = config.id || config.url
  const watchState = readWatchState(state, watchId)
  const events = await loadEvents(config, options)
  const newEvents = []

  for (const event of events) {
    const fingerprint = eventFingerprint(event)
    const legacyMatch = watchState.legacyIds.has(String(event.id))
    if (!watchState.fingerprints.has(fingerprint) && !legacyMatch) newEvents.push(event)
    if (legacyMatch) {
      watchState.legacyIds.delete(String(event.id))
      watchState.migrated = true
    }
    watchState.fingerprints.add(fingerprint)
  }

  if (newEvents.length) await sendNotification(config, newEvents, options)

  if (newEvents.length || watchState.migrated) {
    writeWatchState(state, watchId, watchState)
    if (!options.dryRun) options.saveState(state)
  }

  return newEvents
}

const watch = async (config, state, options) => {
  let lastPing = 0
  const watchId = config.id || config.url
  console.log(`[${new Date().toISOString()}] Watching ${watchId}`)

  while (true) {
    try {
      const newEvents = await checkOnce(config, state, options)
      if (newEvents.length && config.exitAfterNotification) return

      const now = Date.now()
      if (config.pingInterval && now - lastPing >= config.pingInterval * 1000) {
        console.log(`[${new Date().toISOString()}] Watchdog is running; no new matching sessions.`)
        lastPing = now
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Check failed:`, error.message)
      if (options.runOnce) throw error
    }

    if (options.runOnce) return
    await delay(config.refreshInterval * 1000)
  }
}

const loadState = statePath => {
  if (!fs.existsSync(statePath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('state root must be an object')
    }
    return parsed
  } catch (error) {
    throw new Error(`Cannot read state file ${statePath}: ${error.message}`)
  }
}

const saveState = (statePath, state) => {
  const directory = path.dirname(statePath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temporaryPath, statePath)
}

const main = async () => {
  const configPath = fs.existsSync(path.join(__dirname, 'config.json'))
    ? path.join(__dirname, 'config.json')
    : path.join(__dirname, 'default.config.json')
  const configs = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error('Config must be a non-empty array')
  }

  const statePath = process.env.WATCH_STATE_PATH
    ? path.resolve(process.env.WATCH_STATE_PATH)
    : path.join(__dirname, '.watch-state.json')
  const options = {
    dryRun: process.env.DRY_RUN === '1',
    runOnce: process.env.RUN_ONCE === '1',
    saveState: state => saveState(statePath, state)
  }
  const resolvedConfigs = configs.map(config => ({
    ...config,
    startDate: process.env.WATCH_START_DATE || config.startDate,
    endDate: process.env.WATCH_END_DATE || config.endDate
  }))

  resolvedConfigs.forEach(config => validateConfig(config, options))
  const state = loadState(statePath)
  await Promise.all(resolvedConfigs.map(config => watch(config, state, options)))
}

module.exports = {
  bookingLink,
  checkOnce,
  chunksOf,
  downloadJson,
  eventDescription,
  eventFingerprint,
  isoDates,
  loadEvents,
  loadState,
  mapWithConcurrency,
  matches,
  ntfyNotification,
  parseIsoDate,
  readWatchState,
  saveState,
  sendNotification,
  urlsFor,
  validateConfig,
  writeWatchState
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
