const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
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
  saveState,
  sendNotification,
  urlsFor,
  validateConfig
} = require('../app/index')

const config = {
  id: 'test-watch',
  url: 'https://cinema.test/YYYY-MM-DD',
  startDate: '2028-02-28',
  endDate: '2028-03-01',
  filmId: 'film-1',
  cinemaId: '1052',
  auditoriumTinyName: 'IMAX',
  requiredAttributeIds: ['70-mm'],
  ntfyTopic: 'test-topic',
  refreshInterval: 60
}

const event = (overrides = {}) => ({
  id: '123',
  filmId: 'film-1',
  cinemaId: '1052',
  eventDateTime: '2028-02-28T20:30:00',
  attributeIds: ['2d', '70-mm'],
  auditorium: 'IMAX VOLVO',
  auditoriumTinyName: 'IMAX',
  bookingRouterLaunchLink: 'https://cinema.test/book/123',
  ...overrides
})

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
})

test('isoDates is inclusive across a leap day and validates ranges', () => {
  assert.deepEqual(isoDates('2028-02-28', '2028-03-01'), [
    '2028-02-28',
    '2028-02-29',
    '2028-03-01'
  ])
  assert.throws(() => isoDates('2028-02-30', '2028-03-01'), /Invalid ISO date/)
  assert.throws(() => isoDates('2028-03-02', '2028-03-01'), /is after/)
})

test('urlsFor expands every date placeholder', () => {
  assert.deepEqual(urlsFor(config), [
    'https://cinema.test/2028-02-28',
    'https://cinema.test/2028-02-29',
    'https://cinema.test/2028-03-01'
  ])
})

test('matches requires the exact film, cinema, auditorium and attributes', () => {
  assert.equal(matches(config, event()), true)
  assert.equal(matches(config, event({ filmId: 'other' })), false)
  assert.equal(matches(config, event({ cinemaId: '999' })), false)
  assert.equal(matches(config, event({ auditoriumTinyName: '4DX' })), false)
  assert.equal(matches(config, event({ attributeIds: ['2d'] })), false)
})

test('event fingerprint ignores attribute ordering but detects schedule changes', () => {
  assert.equal(
    eventFingerprint(event()),
    eventFingerprint(event({ attributeIds: ['70-mm', '2d'] }))
  )
  assert.notEqual(
    eventFingerprint(event()),
    eventFingerprint(event({ eventDateTime: '2028-02-28T21:00:00' }))
  )
  assert.notEqual(
    eventFingerprint(event()),
    eventFingerprint(event({ auditorium: 'IMAX 2' }))
  )
})

test('bookingLink prefers the router and repairs legacy API links', () => {
  assert.equal(bookingLink(event()), 'https://cinema.test/book/123')
  assert.equal(
    bookingLink(event({ bookingRouterLaunchLink: null, bookingLink: 'https://x.test/api/order/123' })),
    'https://x.test/order/123'
  )
})

test('eventDescription keeps Cinema City wall-clock time on UTC runners', () => {
  assert.equal(eventDescription(event()), 'po 28. 2. 20:30')
  assert.throws(
    () => eventDescription(event({ eventDateTime: 'not-a-date' })),
    /Invalid eventDateTime/
  )
})

test('loadEvents limits concurrency, filters and deduplicates events', async () => {
  let active = 0
  let peak = 0
  const fetchImpl = async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return jsonResponse({ body: { events: [event(), event({ id: 'other', filmId: 'other' })] } })
  }

  const events = await loadEvents({ ...config, fetchConcurrency: 2 }, { fetchImpl, attempts: 1 })
  assert.equal(peak, 2)
  assert.equal(events.length, 1)
  assert.equal(events[0].id, '123')
})

test('loadEvents rejects a changed Cinema City response schema', async () => {
  await assert.rejects(
    loadEvents(config, { fetchImpl: async () => jsonResponse({ events: [] }), attempts: 1 }),
    /Unexpected Cinema City response schema/
  )
})

test('loadEvents rejects a malformed matching event instead of silently losing it', async () => {
  await assert.rejects(
    loadEvents(config, {
      fetchImpl: async () => jsonResponse({ body: { events: [event({ eventDateTime: null })] } }),
      attempts: 1
    }),
    /Unexpected matching event schema/
  )
})

test('downloadJson retries transient HTTP failures and then succeeds', async () => {
  let attempts = 0
  const result = await downloadJson('https://cinema.test', {
    attempts: 3,
    retryDelayMs: 1,
    fetchImpl: async () => {
      attempts++
      return attempts < 3
        ? jsonResponse({ error: 'temporary' }, 503)
        : jsonResponse({ body: { events: [] } })
    }
  })
  assert.equal(attempts, 3)
  assert.deepEqual(result, { body: { events: [] } })
})

test('mapWithConcurrency preserves result order', async () => {
  const result = await mapWithConcurrency([3, 1, 2], 2, async value => {
    await new Promise(resolve => setTimeout(resolve, value))
    return value * 2
  })
  assert.deepEqual(result, [6, 2, 4])
})

test('ntfyNotification sends JSON, authentication and the booking click target', async () => {
  let request
  await ntfyNotification(
    { ...config, ntfyToken: 'secret' },
    'New dates',
    [event()],
    {
      fetchImpl: async (url, options) => {
        request = { url, options }
        return jsonResponse({ id: 'message' })
      }
    }
  )

  assert.equal(request.url, 'https://ntfy.sh')
  assert.equal(request.options.headers.authorization, 'Bearer secret')
  const payload = JSON.parse(request.options.body)
  assert.equal(payload.topic, 'test-topic')
  assert.equal(payload.click, 'https://cinema.test/book/123')
  assert.match(payload.message, /1 nových termínů/)
})

test('checkOnce saves only after successful notification and deduplicates later runs', async () => {
  const state = {}
  let saved = 0
  let notifications = 0
  const options = {
    attempts: 1,
    fetchImpl: async (url, request = {}) => {
      if (request.method === 'POST') {
        notifications++
        return jsonResponse({ id: 'message' })
      }
      return jsonResponse({ body: { events: [event()] } })
    },
    saveState: () => saved++
  }

  assert.equal((await checkOnce(config, state, options)).length, 1)
  assert.equal((await checkOnce(config, state, options)).length, 0)
  assert.equal(notifications, 1)
  assert.equal(saved, 1)
})

test('checkOnce does not mark an event known when ntfy fails', async () => {
  const state = {}
  const options = {
    attempts: 1,
    fetchImpl: async (url, request = {}) =>
      request.method === 'POST'
        ? jsonResponse({ error: 'down' }, 503)
        : jsonResponse({ body: { events: [event()] } }),
    saveState: () => assert.fail('state must not be saved')
  }

  await assert.rejects(checkOnce(config, state, options), /ntfy notification failed/)
  assert.deepEqual(state, {})
})

test('a changed time under the same Cinema City ID creates a new alert', async () => {
  const state = {}
  let currentEvent = event()
  let notifications = 0
  const options = {
    attempts: 1,
    fetchImpl: async (url, request = {}) => {
      if (request.method === 'POST') {
        notifications++
        return jsonResponse({ id: 'message' })
      }
      return jsonResponse({ body: { events: [currentEvent] } })
    },
    saveState: () => {}
  }

  await checkOnce(config, state, options)
  currentEvent = event({ eventDateTime: '2028-02-28T21:00:00' })
  await checkOnce(config, state, options)
  assert.equal(notifications, 2)
  assert.equal(state['test-watch'].fingerprints.length, 2)
})

test('legacy ID state migrates without sending a duplicate', async () => {
  const state = { 'test-watch': ['123', 'not-currently-listed'] }
  let saved = 0
  const result = await checkOnce(config, state, {
    attempts: 1,
    fetchImpl: async () => jsonResponse({ body: { events: [event()] } }),
    saveState: () => saved++
  })

  assert.deepEqual(result, [])
  assert.equal(saved, 1)
  assert.equal(state['test-watch'].version, 2)
  assert.equal(state['test-watch'].fingerprints.length, 1)
  assert.deepEqual(state['test-watch'].legacyIds, ['not-currently-listed'])
})

test('state I/O is atomic and rejects corruption instead of losing deduplication', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cinema-loader-'))
  const statePath = path.join(directory, 'nested', 'state.json')
  saveState(statePath, { watch: { version: 2, fingerprints: ['abc'] } })
  assert.deepEqual(loadState(statePath), { watch: { version: 2, fingerprints: ['abc'] } })

  fs.writeFileSync(statePath, '{broken')
  assert.throws(() => loadState(statePath), /Cannot read state file/)
})

test('notification chunks have a safe fixed upper bound', () => {
  assert.deepEqual(chunksOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.throws(() => chunksOf([1], 0), /positive/)
})

test('sendNotification splits a large schedule into multiple ntfy messages', async () => {
  let posts = 0
  const events = Array.from({ length: 9 }, (_, index) =>
    event({ id: String(index), bookingRouterLaunchLink: `https://cinema.test/book/${index}` })
  )
  await sendNotification(config, events, {
    fetchImpl: async () => {
      posts++
      return jsonResponse({ id: String(posts) })
    }
  })
  assert.equal(posts, 2)
})

test('validateConfig catches missing ntfy and accepts dry runs', () => {
  assert.throws(
    () => validateConfig({ ...config, ntfyTopic: undefined }, { runOnce: true }),
    /NTFY_TOPIC is not configured/
  )
  assert.doesNotThrow(() =>
    validateConfig({ ...config, ntfyTopic: undefined }, { runOnce: true, dryRun: true })
  )
})
