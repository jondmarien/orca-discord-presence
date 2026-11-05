var orca = window.orca
var REQUEST_TIMEOUT_MS = 5000
var TIMELINE_CELLS = 30
var STATES = ['working', 'waiting', 'blocked', 'idle']
var STATE_ASSET_RE = /^state-(working|waiting|blocked|idle)$/
var SWITCH_FIELDS = ['showAgentState', 'showAgentCount', 'showElapsed', 'showBranch', 'showTerminals', 'showMachine']

function $(id) {
  return document.getElementById(id)
}

// Why: snapshots arrive on every agent event; writing unchanged values
// re-lays out the panel and makes it look like it rebuilds itself.
function setText(id, value, fallback) {
  var el = $(id)
  var next = value == null || value === '' ? (fallback == null ? '' : fallback) : String(value)
  if (el && el.textContent !== next) el.textContent = next
}

function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function setClass(el, name, on) {
  if (el && el.className.split(/\s+/).indexOf(name) === -1 === !!on) el.classList.toggle(name, !!on)
}

function flash(message) {
  setText('flash', message)
}

function normalizeState(state) {
  return STATES.indexOf(state) === -1 ? 'none' : state
}

function barClass(snapshot) {
  var kind = 'is-waiting'
  if (snapshot && snapshot.status) {
    if (!snapshot.fields || snapshot.fields.enabled === false) kind = 'is-disabled'
    else if (snapshot.status.connected) kind = 'is-connected'
    else if (snapshot.status.sink === 'bridge') kind = 'is-bridge'
    else if (snapshot.status.enabled) kind = 'is-down'
    else kind = 'is-disabled'
  }
  return 'row between ' + kind
}

function indicatorLabel(snapshot) {
  if (!snapshot || !snapshot.status) return 'Waiting for worker snapshot'
  if (snapshot.fields && snapshot.fields.enabled === false) return 'Disabled'
  if (snapshot.status.connected) return 'Connected · local'
  if (snapshot.status.sink === 'bridge') return 'Publishing · bridge'
  if (snapshot.status.enabled) return 'Disconnected'
  return 'Disabled'
}

function sinkTile(snapshot) {
  var status = snapshot.status
  if (snapshot.fields && snapshot.fields.enabled === false) return ['Off', 'Disabled']
  if (status.connected) return ['Local', 'Discord IPC']
  if (status.sink === 'bridge') return ['Bridge', 'Companion app']
  return ['Off', 'Not connected']
}

function formatElapsed(ms) {
  var total = Math.max(0, Math.floor(ms / 1000))
  var pad = function (n) {
    return n < 10 ? '0' + n : String(n)
  }
  return pad(Math.floor(total / 3600)) + ':' + pad(Math.floor((total % 3600) / 60)) + ':' + pad(total % 60)
}

function formatSince(ms) {
  var s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  return Math.floor(s / 3600) + 'h'
}

// Timer: only the timer node is touched each second (no full re-render).
var timerStartMs = null
function tickTimer() {
  if (timerStartMs == null) return
  setText('dcard-timer', formatElapsed(Date.now() - timerStartMs) + ' elapsed')
}

function buildStrip() {
  var strip = $('strip')
  for (var i = 0; i < TIMELINE_CELLS; i += 1) {
    var cell = document.createElement('i')
    cell.setAttribute('data-state', 'none')
    strip.appendChild(cell)
  }
}

function renderStrip(timeline) {
  var cells = $('strip').children
  var slots = Array.isArray(timeline) ? timeline : []
  // Why: a short timeline aligns to the right edge ("now"); the rest is no data.
  var offset = TIMELINE_CELLS - Math.min(slots.length, TIMELINE_CELLS)
  var start = Math.max(0, slots.length - TIMELINE_CELLS)
  for (var i = 0; i < cells.length; i += 1) {
    var slot = i < offset ? null : slots[start + i - offset]
    setAttr(cells[i], 'data-state', normalizeState(slot))
  }
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

var agentsSignature = null
function renderAgents(agents) {
  var list = Array.isArray(agents) ? agents : []
  var signature = list
    .map(function (a) {
      return a.kind + '|' + a.state + '|' + formatSince(a.sinceMs)
    })
    .join(';')
  setClass($('agents-empty'), 'hidden', list.length > 0)
  if (signature === agentsSignature) return
  agentsSignature = signature
  var box = $('agents-list')
  clearChildren(box)
  list.forEach(function (agent) {
    var row = document.createElement('div')
    row.className = 'agent-row'
    var kind = document.createElement('span')
    kind.textContent = String(agent.kind || 'agent')
    var chip = document.createElement('span')
    chip.className = 'chip'
    var state = agent.state === 'done' ? 'idle' : normalizeState(agent.state)
    chip.setAttribute('data-state', state)
    chip.textContent = (agent.state === 'done' ? 'idle' : agent.state) + ' · ' + formatSince(agent.sinceMs)
    row.appendChild(kind)
    row.appendChild(chip)
    box.appendChild(row)
  })
}

var mixSignature = null
function renderMix(agents) {
  var counts = {}
  ;(Array.isArray(agents) ? agents : []).forEach(function (agent) {
    var state = agent.state === 'done' ? 'idle' : normalizeState(agent.state)
    counts[state] = (counts[state] || 0) + 1
  })
  var signature = STATES.map(function (s) {
    return s + counts[s]
  }).join(',')
  if (signature === mixSignature) return
  mixSignature = signature
  var mix = $('tile-mix')
  clearChildren(mix)
  STATES.forEach(function (state) {
    if (!counts[state]) return
    var part = document.createElement('i')
    part.setAttribute('data-state', state)
    part.style.flex = String(counts[state])
    mix.appendChild(part)
  })
}

function renderCard(snapshot) {
  var card = snapshot.activityCard
  var summary = snapshot.status.lastActivity
  var details = card ? card.details : summary && summary.details
  var state = card ? card.state : summary && summary.state
  setText('dcard-details', details, 'Waiting for first update')
  setText('dcard-state', state)
  // Why: the key becomes part of a file path, so only known state assets pass.
  var key = card && STATE_ASSET_RE.test(card.smallImageKey) ? card.smallImageKey : 'state-idle'
  setAttr($('dcard-img'), 'src', '../assets/' + key + '.png')
  var showTimer = !!(card && card.startMs) && !(snapshot.fields && snapshot.fields.showElapsed === false)
  timerStartMs = showTimer ? card.startMs : null
  setClass($('dcard-timer'), 'hidden', !showTimer)
  tickTimer()
}

function render(snapshot) {
  setAttr($('status-bar'), 'class', barClass(snapshot))
  setText('indicator-label', indicatorLabel(snapshot))
  if (!snapshot || !snapshot.status) return
  var fields = snapshot.fields || {}
  renderCard(snapshot)
  renderStrip(snapshot.timeline)
  var agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
  setText('tile-agents', agents.length)
  renderMix(agents)
  var sink = sinkTile(snapshot)
  setText('tile-sink', sink[0])
  setText('tile-sink-sub', sink[1])
  var detailEls = $('detail-seg').children
  for (var i = 0; i < detailEls.length; i += 1) {
    setClass(detailEls[i], 'on', detailEls[i].getAttribute('data-detail') === snapshot.status.detailLevel)
  }
  renderAgents(agents)
  SWITCH_FIELDS.forEach(function (name) {
    var el = $('sw-' + name)
    setClass(el, 'on', fields[name])
    setAttr(el, 'aria-checked', fields[name] ? 'true' : 'false')
  })
  setText('btn-toggle', fields.enabled === false ? 'Resume' : 'Pause')
  var logs = snapshot.logs || []
  setText('logs-summary', 'Logs (' + logs.length + ')')
  if (logs.length) {
    var view = $('log-view')
    var text = logs.join('\n')
    if (view.textContent !== text) {
      // Why: keep the reader's place; only follow the tail when already at the bottom.
      var atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 4
      view.textContent = text
      if (atBottom) view.scrollTop = view.scrollHeight
    }
  }
}

function request(name, input) {
  return orca.plugin.request(name, input, { timeoutMs: REQUEST_TIMEOUT_MS })
}

function errorText(error) {
  return (error && (error.message || error.code)) || 'error'
}

function refresh() {
  return request('presence.snapshot', {}).then(render, function (error) {
    flash('Snapshot failed: ' + errorText(error))
  })
}

function run(command, doneMessage) {
  return request('presence.run', { command: command }).then(
    function (result) {
      flash(result && result.ok === false ? result.message || 'Command failed.' : doneMessage)
      return refresh()
    },
    function (error) {
      flash('Command failed: ' + errorText(error))
    }
  )
}

function wireLogs() {
  $('btn-log-clear').addEventListener('click', function () {
    $('log-view').textContent = ''
    flash('Cleared this view only (not the on-disk log).')
  })
  $('btn-log-copy').addEventListener('click', function () {
    var text = $('log-view').textContent || ''
    var fallback = function () {
      var range = document.createRange()
      range.selectNodeContents($('log-view'))
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      flash('Logs selected — copy with the system shortcut.')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flash('Logs copied.')
      }, fallback)
    } else {
      fallback()
    }
  })
}

function applyTheme(payload) {
  var theme = typeof payload === 'string' ? payload : payload && (payload.theme || payload.mode)
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
}

// Why: tests only. Non-enumerable so it never shows up when iterating window.
Object.defineProperty(window, '__presencePanel', { value: { render: render }, enumerable: false })

buildStrip()

if (!orca || !orca.plugin || typeof orca.plugin.request !== 'function') {
  $('app').classList.add('hidden')
  var note = $('static-note')
  note.textContent = 'Open this panel in the Orca desktop app to see live status.'
  note.classList.remove('hidden')
} else {
  wireLogs()
  $('btn-status').addEventListener('click', function () {
    run('presence.status', 'Status sent as a notification.')
  })
  $('btn-toggle').addEventListener('click', function () {
    run('presence.toggle', 'Toggled presence.')
  })
  $('btn-reload').addEventListener('click', function () {
    run('presence.reload', 'Reloaded the Discord connection.')
  })
  $('btn-clear').addEventListener('click', function () {
    run('presence.clear', 'Presence cleared until the next event.')
  })
  if (typeof orca.plugin.on === 'function') {
    orca.plugin.on('presence.snapshot', render)
  }
  if (typeof orca.on === 'function') {
    try {
      orca.on('theme', applyTheme)
    } catch (error) {
      // Why: older hosts reject unknown events; frame variables still theme the panel.
    }
  }
  if (typeof setInterval === 'function') setInterval(tickTimer, 1000)
  refresh()
}
