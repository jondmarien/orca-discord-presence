var orca = window.orca
var REQUEST_TIMEOUT_MS = 5000
var TIMELINE_CELLS = 30
var STATES = ['working', 'waiting', 'blocked', 'completed', 'idle']
var STATE_ASSET_RE = /^state-(working|waiting|blocked|completed|idle)$/
// Why: Orca's `done` is shown as `completed`; the snapshot keeps the raw name.
function displayState(state) {
  return state === 'done' ? 'completed' : state
}
// Why: the Discord key (minus suffix) names a local file; this map is the one
// place that decides which file backs each state.
var STATE_FILES = {
  working: 'state-working',
  waiting: 'state-waiting',
  blocked: 'state-blocked',
  completed: 'orca-completed',
  idle: 'state-idle'
}
function stateImage(state) {
  return '../assets/' + (STATE_FILES[state] || STATE_FILES.idle) + '.png'
}
var DETAIL_LEVELS = [
  ['off', 'Off'],
  ['generic', 'Generic'],
  ['workspace', 'Workspace'],
  ['full', 'Full']
]
var VIEW_KEY = 'panelView'
var FULL_ONLY_IDS = ['full-a', 'full-b', 'full-c', 'full-d']
// Hideable sections: [id kept in storage and the hiddenPanels setting, element id, label].
// The ids must match HIDDEN_PANEL_IDS in src/presence/settings.ts.
var PANEL_SECTIONS = [
  ['preview', 'full-a', 'Discord preview'],
  ['strip', 'strip-card', 'Last 30 min'],
  ['tiles', 'full-b', 'Tiles'],
  ['client', 'client-card', 'Discord client'],
  ['detail', 'detail-card', 'Detail level'],
  ['agents', 'agents-card', 'Agents'],
  ['toggles', 'toggles-card', 'Show on Discord'],
  ['actions', 'actions-row', 'Actions'],
  ['logs', 'logs-box', 'Logs']
]
var HIDDEN_KEY = 'panelHidden'
var HIDDEN_SETTING = 'hiddenPanels'
var SETTINGS_MIRROR_DELAY_MS = 400
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
    else if (snapshot.status.connected) kind = snapshot.status.localFailing ? 'is-failing' : 'is-connected'
    else if (snapshot.status.sink === 'bridge') kind = 'is-bridge'
    else if (snapshot.status.enabled) kind = 'is-down'
    else kind = 'is-disabled'
  }
  return 'row between ' + kind
}

function indicatorLabel(snapshot) {
  if (!snapshot || !snapshot.status) return 'Waiting for worker snapshot'
  if (snapshot.fields && snapshot.fields.enabled === false) return 'Disabled'
  if (snapshot.status.connected) return snapshot.status.localFailing ? 'Connected · updates failing' : 'Connected · local'
  if (snapshot.status.sink === 'bridge') return 'Publishing · bridge'
  if (snapshot.status.enabled) return 'Disconnected'
  return 'Disabled'
}

function sinkTile(snapshot) {
  var status = snapshot.status
  if (snapshot.fields && snapshot.fields.enabled === false) return ['Off', 'Disabled']
  if (status.connected) return ['Local', status.client && status.client.label ? status.client.label + ' \u00b7 IPC' : 'Discord IPC']
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

// Why: long chat names are truncated; scroll the overflowing ones back and forth
// so they stay readable. Measured after layout; reduced motion keeps the
// ellipsis and the hover tooltip instead (see panel.css).
var marqueeTitles = []
var MARQUEE_PX_PER_S = 30
function scheduleMarquee() {
  // Why: measure after layout; environments without a frame callback (tests)
  // simply skip the marquee.
  if (typeof window.requestAnimationFrame !== 'function') return
  window.requestAnimationFrame(function () {
    marqueeTitles.forEach(function (title) {
      var overflow = title.scrollWidth - title.clientWidth
      if (overflow > 2) {
        title.classList.add('marquee')
        title.style.setProperty('--marquee-shift', -overflow + 'px')
        // Pause ~1.5s at each end; the slide itself runs at a steady speed.
        title.style.setProperty('--marquee-duration', (overflow / MARQUEE_PX_PER_S) * 2 + 3 + 's')
      } else {
        title.classList.remove('marquee')
      }
    })
  })
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
  tickAgents()
  if (timerStartMs == null) return
  setText('dcard-timer', formatElapsed(Date.now() - timerStartMs) + ' elapsed')
  updateMeta()
}

function buildStrip() {
  var strip = $('strip')
  for (var i = 0; i < TIMELINE_CELLS; i += 1) {
    var cell = document.createElement('i')
    cell.setAttribute('data-state', 'none')
    strip.appendChild(cell)
  }
}

// Why: a minute lists every state present, strongest first. One state keeps the
// cell solid; several stack as equal segments inside it. `data-state` stays the
// strongest so the cell colour rule is unchanged. A bare string (older worker)
// reads as a single state.
function slotStates(slot) {
  if (Array.isArray(slot)) return slot.filter(function (s) { return STATES.indexOf(s) !== -1 })
  return STATES.indexOf(slot) === -1 ? [] : [slot]
}

function renderStrip(timeline) {
  var cells = $('strip').children
  var slots = Array.isArray(timeline) ? timeline : []
  // Why: a short timeline aligns to the right edge ("now"); the rest is no data.
  var offset = TIMELINE_CELLS - Math.min(slots.length, TIMELINE_CELLS)
  var start = Math.max(0, slots.length - TIMELINE_CELLS)
  for (var i = 0; i < cells.length; i += 1) {
    var states = i < offset ? [] : slotStates(slots[start + i - offset])
    var cell = cells[i]
    setAttr(cell, 'data-state', states.length ? states[0] : 'none')
    setClass(cell, 'multi', states.length > 1)
    var joined = states.join(' ')
    if ((cell.getAttribute('data-states') || '') === joined) continue
    setAttr(cell, 'data-states', joined)
    clearChildren(cell)
    if (states.length > 1) {
      states.forEach(function (state) {
        var seg = document.createElement('b')
        seg.setAttribute('data-state', state)
        cell.appendChild(seg)
      })
    }
  }
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

// Why: snapshot `sinceMs` is the epoch time the agent entered its state, so
// the chip shows the age; rows keep their chip nodes for the 1 s tick.
function chipText(agent) {
  return displayState(agent.state) + ' \u00b7 ' + formatSince(Math.max(0, Date.now() - agent.sinceMs))
}

var agentChips = []
function tickAgents() {
  agentChips.forEach(function (entry) {
    var next = chipText(entry.agent)
    if (entry.chip.textContent !== next) entry.chip.textContent = next
    // Why: a narrow chip ellipsizes, so the full age stays on hover.
    setAttr(entry.chip, 'title', next)
  })
}

var agentsSignature = null
function renderAgents(agents) {
  var list = Array.isArray(agents) ? agents : []
  var signature = list
    .map(function (a) {
      return a.kind + '|' + (a.title || '') + '|' + a.state + '|' + a.sinceMs
    })
    .join(';')
  setClass($('agents-empty'), 'hidden', list.length > 0)
  if (signature === agentsSignature) return
  agentsSignature = signature
  var box = $('agents-list')
  clearChildren(box)
  agentChips = []
  marqueeTitles = []
  list.forEach(function (agent) {
    var row = document.createElement('div')
    row.className = 'agent-row'
    // Why: kind, muted ` | `, then the chat name; only the title truncates.
    var label = document.createElement('span')
    label.className = 'agent-label'
    var kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = String(agent.kind || 'agent')
    label.appendChild(kind)
    if (agent.title) {
      var sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = ' | '
      var title = document.createElement('span')
      title.className = 'title'
      title.setAttribute('title', String(agent.title))
      var inner = document.createElement('span')
      inner.className = 'title-inner'
      inner.textContent = String(agent.title)
      title.appendChild(inner)
      label.appendChild(sep)
      label.appendChild(title)
      marqueeTitles.push(title)
    }
    var chip = document.createElement('span')
    chip.className = 'chip'
    var state = normalizeState(displayState(agent.state))
    chip.setAttribute('data-state', state)
    chip.textContent = chipText(agent)
    chip.setAttribute('title', chip.textContent)
    agentChips.push({ agent: agent, chip: chip })
    row.appendChild(label)
    row.appendChild(chip)
    box.appendChild(row)
  })
  scheduleMarquee()
}

var mixSignature = null
function renderMix(agents) {
  var counts = {}
  ;(Array.isArray(agents) ? agents : []).forEach(function (agent) {
    var state = normalizeState(displayState(agent.state))
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
  var match = card && STATE_ASSET_RE.exec(card.smallImageKey)
  setAttr($('dcard-img'), 'src', stateImage(match ? match[1] : 'idle'))
  var showTimer = !!(card && card.startMs) && !(snapshot.fields && snapshot.fields.showElapsed === false)
  timerStartMs = showTimer ? card.startMs : null
  setClass($('dcard-timer'), 'hidden', !showTimer)
  tickTimer()
}

// Why: the hero reads the same icon key as the card, so both views agree.
function stateOf(snapshot) {
  var card = snapshot.activityCard
  var match = card && STATE_ASSET_RE.exec(card.smallImageKey)
  return match ? match[1] : 'idle'
}

function renderMinimal(snapshot, agents) {
  var state = stateOf(snapshot)
  var card = snapshot.activityCard
  var summary = snapshot.status.lastActivity
  var details = card ? card.details : summary && summary.details
  setAttr($('min-hero'), 'data-state', state)
  setAttr($('min-img'), 'src', stateImage(state))
  setText('min-state', state.charAt(0).toUpperCase() + state.slice(1))
  setText('min-details', details ? '\u201c' + details + '\u201d' : '')
  updateMeta()
}

// Timer + agent count share one node; only its text changes each second.
var minAgents = 0
function updateMeta() {
  var parts = [minAgents + (minAgents === 1 ? ' agent' : ' agents')]
  if (timerStartMs != null) parts.push(formatElapsed(Date.now() - timerStartMs))
  setText('min-meta', parts.join(' \u00b7 '))
}

var lastSnapshot = null
function render(snapshot) {
  setAttr($('status-bar'), 'class', barClass(snapshot))
  setText('indicator-label', indicatorLabel(snapshot))
  if (!snapshot || !snapshot.status) return
  lastSnapshot = snapshot
  syncHiddenSetting(snapshot)
  var fields = snapshot.fields || {}
  minAgents = Array.isArray(snapshot.agents) ? snapshot.agents.length : 0
  renderCard(snapshot)
  renderStrip(snapshot.timeline)
  var agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
  setText('tile-agents', agents.length)
  renderMix(agents)
  var sink = sinkTile(snapshot)
  setText('tile-sink', sink[0])
  setText('tile-sink-sub', sink[1])
  renderMinimal(snapshot, agents)
  renderControls(snapshot)
  renderAgents(agents)
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

var pending = {}

// Why: a write that fails must not leave the control showing a value the
// worker never accepted, so every control re-reads the last snapshot.
function renderControls(snapshot) {
  var fields = snapshot.fields || {}
  var detailEls = $('detail-seg').children
  for (var i = 0; i < detailEls.length; i += 1) {
    var level = detailEls[i].getAttribute('data-detail')
    setClass(detailEls[i], 'on', level === snapshot.status.detailLevel)
    setAttr(detailEls[i], 'aria-pressed', level === snapshot.status.detailLevel ? 'true' : 'false')
  }
  renderClients(snapshot)
  SWITCH_FIELDS.forEach(function (name) {
    var el = $('sw-' + name)
    if (el && !pending[name] && el.checked !== !!fields[name]) el.checked = !!fields[name]
  })
}

// Why: the card shows whenever a client is detected so the choice is always
// visible. Options are rebuilt only when the list or the saved id changes; the
// chosen one is re-read from the snapshot, so a rejected write reverts by itself.
var clientsSignature = null
var CLIENT_FAMILY_NAMES = {
  vesktop: 'Vesktop',
  'discord-flatpak': 'Discord (Flatpak)',
  'discord-snap': 'Discord (Snap)',
  discord: 'Discord'
}
function clientIdName(id) {
  var family = String(id).split(':')[0]
  return CLIENT_FAMILY_NAMES[family] || String(id)
}
function renderClients(snapshot) {
  var clients = Array.isArray(snapshot.status.clients) ? snapshot.status.clients : []
  var fields = snapshot.fields || {}
  var chosen = fields.discordClient || 'auto'
  setClass($('client-card'), 'hidden', clients.length < 1)
  var detected = clients.some(function (c) {
    return c.id === chosen
  })
  var missing = chosen !== 'auto' && !detected
  var signature =
    clients
      .map(function (c) {
        return c.id + '|' + c.label
      })
      .join(';') +
    '#' +
    (missing ? chosen : '')
  var select = $('client-select')
  if (signature !== clientsSignature) {
    clientsSignature = signature
    clearChildren(select)
    var entries = [{ id: 'auto', label: 'Auto (first found)' }].concat(clients)
    if (missing) entries.push({ id: chosen, label: clientIdName(chosen) + ' (not running)', disabled: true })
    entries.forEach(function (entry) {
      var option = document.createElement('option')
      option.setAttribute('value', entry.id)
      option.value = entry.id
      option.textContent = entry.label
      option.disabled = !!entry.disabled
      select.appendChild(option)
    })
  }
  if (!pending.discordClient) select.value = chosen
  var fallback = !!snapshot.status.clientFallback
  setClass($('client-note'), 'hidden', !fallback)
  setText(
    'client-note',
    fallback
      ? 'Chosen client not running \u2014 using ' +
          (snapshot.status.client ? snapshot.status.client.label : 'the first one found') +
          '.'
      : ''
  )
}

function setBusy(el, busy) {
  el.disabled = busy
  el.setAttribute('aria-busy', busy ? 'true' : 'false')
}

function writeSetting(key, value, els) {
  var host = orca && orca.host
  if (!host || typeof host.call !== 'function') {
    flash('Settings are not available in this host.')
    if (lastSnapshot) renderControls(lastSnapshot)
    return Promise.resolve()
  }
  pending[key] = true
  els.forEach(function (el) {
    setBusy(el, true)
  })
  var done = function () {
    pending[key] = false
    els.forEach(function (el) {
      setBusy(el, false)
    })
    if (lastSnapshot) renderControls(lastSnapshot)
  }
  return Promise.resolve()
    .then(function () {
      return host.call('settings.set', { key: key, value: value })
    })
    .then(done, function (error) {
      flash(errorText(error))
      done()
    })
}

function wireControls() {
  var clientSelect = $('client-select')
  clientSelect.addEventListener('change', function () {
    writeSetting('discordClient', clientSelect.value, [clientSelect])
  })
  SWITCH_FIELDS.forEach(function (name) {
    var el = $('sw-' + name)
    el.addEventListener('change', function () {
      writeSetting(name, !!el.checked, [el])
    })
  })
  var seg = $('detail-seg')
  DETAIL_LEVELS.forEach(function (level) {
    var button = document.createElement('button')
    button.setAttribute('type', 'button')
    button.setAttribute('data-detail', level[0])
    button.textContent = level[1]
    button.addEventListener('click', function () {
      var buttons = Array.prototype.slice.call(seg.children)
      writeSetting('detailLevel', level[0], buttons)
    })
    seg.appendChild(button)
  })
}

// View: 'full' unless storage holds exactly 'minimal'. Storage may be absent,
// reject, or hold junk; none of that may break the panel.
var view = 'full'
function applyView(next) {
  view = next === 'minimal' ? 'minimal' : 'full'
  FULL_ONLY_IDS.forEach(function (id) {
    setClass($(id), 'hidden', view === 'minimal')
  })
  setClass($('min-hero'), 'hidden', view !== 'minimal')
  setClass($('view-full'), 'on', view === 'full')
  setClass($('view-minimal'), 'on', view === 'minimal')
}

function storedView(result) {
  return result && typeof result === 'object' ? result.value : result
}

function loadView() {
  var host = orca && orca.host
  if (!host || typeof host.call !== 'function') return Promise.resolve()
  return Promise.resolve()
    .then(function () {
      return host.call('storage.get', { key: VIEW_KEY })
    })
    .then(
      function (result) {
        applyView(storedView(result))
      },
      function () {
        applyView('full')
      }
    )
}

function chooseView(next) {
  applyView(next)
  var host = orca && orca.host
  if (!host || typeof host.call !== 'function') return
  Promise.resolve()
    .then(function () {
      return host.call('storage.set', { key: VIEW_KEY, value: view })
    })
    .catch(function () {
      // Why: the choice still applies for this session when it cannot be saved.
    })
}

// Hidden sections: storage `panelHidden` is the runtime source; the
// `hiddenPanels` setting mirrors it for the Settings page and arrives in the
// snapshot as `hidden`. Storage wins on load whichever answer lands first; a
// later change to the setting (a Settings page edit) is adopted. Junk in
// either source is ignored. A separate class keeps this apart from the
// `hidden` class that views and the client card toggle.
var hiddenIds = []
var hiddenFromStorage = false
var settingsHiddenSig = null
var settingsTimer = null

function normalizeHidden(list) {
  if (!Array.isArray(list)) return null
  return PANEL_SECTIONS.map(function (s) {
    return s[0]
  }).filter(function (id) {
    return list.indexOf(id) !== -1
  })
}

function callHost(name, input) {
  var host = orca && orca.host
  if (!host || typeof host.call !== 'function') return
  Promise.resolve()
    .then(function () {
      return host.call(name, input)
    })
    .catch(function () {
      // Why: hiding still applies for this session when it cannot be saved.
    })
}

function applyHidden(list) {
  hiddenIds = list
  PANEL_SECTIONS.forEach(function (s) {
    var off = hiddenIds.indexOf(s[0]) !== -1
    setClass($(s[1]), 'user-hidden', off)
    setAttr($('eye-' + s[0]), 'aria-pressed', off ? 'true' : 'false')
  })
  renderTray()
}

var traySignature = null
function renderTray() {
  var count = hiddenIds.length
  setClass($('hidden-tray'), 'hidden', count === 0)
  setText('hidden-tray-label', 'Hidden (' + count + ')')
  setText('show-all-count', count || '')
  $('btn-show-all').disabled = count === 0
  var signature = hiddenIds.join(',')
  if (signature === traySignature) return
  traySignature = signature
  var box = $('hidden-chips')
  clearChildren(box)
  PANEL_SECTIONS.forEach(function (s) {
    if (hiddenIds.indexOf(s[0]) === -1) return
    var chip = document.createElement('button')
    chip.setAttribute('type', 'button')
    chip.className = 'btn sm'
    chip.setAttribute('aria-label', 'Show ' + s[2])
    chip.textContent = s[2]
    chip.addEventListener('click', function () {
      setHidden(
        hiddenIds.filter(function (id) {
          return id !== s[0]
        })
      )
    })
    box.appendChild(chip)
  })
}

function setHidden(list) {
  hiddenFromStorage = true
  applyHidden(normalizeHidden(list))
  callHost('storage.set', { key: HIDDEN_KEY, value: hiddenIds.slice() })
  var mirror = function () {
    settingsTimer = null
    callHost('settings.set', { key: HIDDEN_SETTING, value: hiddenIds.join(',') })
  }
  if (typeof setTimeout !== 'function') return mirror()
  if (settingsTimer) clearTimeout(settingsTimer)
  settingsTimer = setTimeout(mirror, SETTINGS_MIRROR_DELAY_MS)
}

function loadHidden() {
  var host = orca && orca.host
  if (!host || typeof host.call !== 'function') return Promise.resolve()
  return Promise.resolve()
    .then(function () {
      return host.call('storage.get', { key: HIDDEN_KEY })
    })
    .then(
      function (result) {
        var list = normalizeHidden(Array.isArray(result) ? result : storedView(result))
        // Why: a toggle made before storage answered is newer than what it holds.
        if (!list || hiddenFromStorage) return
        hiddenFromStorage = true
        applyHidden(list)
      },
      function () {}
    )
}

function syncHiddenSetting(snapshot) {
  var list = normalizeHidden(snapshot.hidden)
  if (!list) return
  var signature = list.join(',')
  if (signature === settingsHiddenSig) return
  var first = settingsHiddenSig === null
  settingsHiddenSig = signature
  if ((first && hiddenFromStorage) || signature === hiddenIds.join(',')) return
  applyHidden(list)
  if (!first) {
    hiddenFromStorage = true
    callHost('storage.set', { key: HIDDEN_KEY, value: list.slice() })
  }
}

function wireHidden() {
  PANEL_SECTIONS.forEach(function (s) {
    $('eye-' + s[0]).addEventListener('click', function (event) {
      // Why: the logs eye sits in <summary>; a click must not fold the logs.
      if (event && event.preventDefault) event.preventDefault()
      setHidden(hiddenIds.concat(s[0]))
    })
  })
  var showAll = function () {
    setHidden([])
  }
  $('btn-show-all').addEventListener('click', showAll)
  $('tray-show-all').addEventListener('click', showAll)
  renderTray()
  loadHidden()
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

// Why: forces the worker to resync agents, workspace and Discord clients. The
// button is disabled while pending so a mash is one request; render() touches
// only changed nodes, so the returned snapshot does not rebuild the panel.
function forceRefresh() {
  var button = $('btn-refresh')
  if (button.disabled) return Promise.resolve()
  setBusy(button, true)
  setClass(button, 'spin', true)
  var done = function () {
    setBusy(button, false)
    setClass(button, 'spin', false)
  }
  return request('presence.refresh', {}).then(
    function (snapshot) {
      done()
      render(snapshot)
    },
    function (error) {
      done()
      flash('Refresh failed: ' + errorText(error))
    }
  )
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
  wireControls()
  $('view-full').addEventListener('click', function () {
    chooseView('full')
  })
  $('view-minimal').addEventListener('click', function () {
    chooseView('minimal')
  })
  loadView()
  wireHidden()
  $('btn-refresh').addEventListener('click', forceRefresh)
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
