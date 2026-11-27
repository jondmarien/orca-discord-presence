/**
 * Interactive panel controls: detail segmented control, Discord client picker,
 * field switches, session-stats selector, action buttons, refresh button, and
 * logs toolbar (`Clear`, `execCommand('copy')`, `orca.files.saveAs`).
 *
 * @module panel/controls
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { PresencePanelSnapshot } from '../presence/panel-snapshot'
import { $, clearChildren, errorText, flash, setAttr, setBusy, setClass, setText } from './dom'
import { getOrca, request } from './host-bridge'
import { CLIENT_FAMILY_NAMES, DETAIL_LEVEL_ENTRIES, SWITCH_FIELDS } from './sections'

type BusyControl = HTMLButtonElement | HTMLInputElement | HTMLSelectElement

let clientsSignature: string | null = null
const pending: Record<string, boolean> = {}

function clientIdName(id: string): string {
  const family = String(id).split(':')[0]
  return CLIENT_FAMILY_NAMES[family] || String(id)
}

function renderClients(snapshot: PresencePanelSnapshot): void {
  const clients = Array.isArray(snapshot.status.clients) ? snapshot.status.clients : []
  const fields = snapshot.fields
  const chosen = fields?.discordClient || 'auto'
  setClass($('client-card'), 'hidden', clients.length < 1)
  const detected = clients.some((c) => c.id === chosen)
  const missing = chosen !== 'auto' && !detected
  const signature = `${clients.map((c) => `${c.id}|${c.label}`).join(';')}#${missing ? chosen : ''}`
  const select = $('client-select') as HTMLSelectElement | null
  if (!select) return
  if (signature !== clientsSignature) {
    clientsSignature = signature
    clearChildren(select)
    const entries: Array<{ id: string; label: string; disabled?: boolean }> = [
      { id: 'auto', label: 'Auto (first found)' },
      ...clients
    ]
    if (missing) {
      entries.push({ id: chosen, label: `${clientIdName(chosen)} (not running)`, disabled: true })
    }
    entries.forEach((entry) => {
      const option = document.createElement('option')
      option.setAttribute('value', entry.id)
      option.value = entry.id
      option.textContent = entry.label
      option.disabled = !!entry.disabled
      select.appendChild(option)
    })
  }
  if (!pending.discordClient && select.value !== chosen) select.value = chosen
  const fallback = !!snapshot.status.clientFallback
  setClass($('client-note'), 'hidden', !fallback)
  setText(
    'client-note',
    fallback
      ? `Chosen client not running \u2014 using ${
          snapshot.status.client ? snapshot.status.client.label : 'the first one found'
        }.`
      : ''
  )
}

/**
 * Re-render controls from the latest accepted snapshot so a rejected write
 * reverts cleanly to worker state.
 */
export function renderControls(snapshot: PresencePanelSnapshot): void {
  const fields = snapshot.fields
  const seg = $('detail-seg')
  if (seg) {
    const detailEls = seg.children
    for (let i = 0; i < detailEls.length; i += 1) {
      const level = detailEls[i].getAttribute('data-detail')
      const active = level === snapshot.status.detailLevel
      setClass(detailEls[i], 'on', active)
      setAttr(detailEls[i], 'aria-pressed', active ? 'true' : 'false')
    }
  }
  renderClients(snapshot)
  SWITCH_FIELDS.forEach((name) => {
    const el = $(`sw-${name}`) as HTMLInputElement | null
    if (el && !pending[name] && el.checked !== !!(fields && fields[name])) {
      el.checked = !!(fields && fields[name])
    }
  })
  const statsSelect = $('sel-showSessionStats') as HTMLSelectElement | null
  const nextStats = fields?.showSessionStats || 'off'
  if (statsSelect && !pending.showSessionStats && statsSelect.value !== nextStats) {
    statsSelect.value = nextStats
  }
}

export function wireControls(getLastSnapshot: () => PresencePanelSnapshot | null): void {
  const writeSetting = (key: string, value: unknown, els: BusyControl[]): Promise<void> => {
    const host = getOrca()?.host
    if (!host || typeof host.call !== 'function') {
      flash('Settings are not available in this host.')
      const snap = getLastSnapshot()
      if (snap) renderControls(snap)
      return Promise.resolve()
    }
    pending[key] = true
    els.forEach((el) => setBusy(el, true))
    const done = () => {
      pending[key] = false
      els.forEach((el) => setBusy(el, false))
      const snap = getLastSnapshot()
      if (snap) renderControls(snap)
    }
    return Promise.resolve()
      .then(() => host.call!('settings.set', { key, value }))
      .then(done, (error) => {
        flash(errorText(error))
        done()
      })
  }

  const clientSelect = $('client-select') as HTMLSelectElement | null
  clientSelect?.addEventListener('change', () => {
    void writeSetting('discordClient', clientSelect.value, [clientSelect])
  })

  SWITCH_FIELDS.forEach((name) => {
    const el = $(`sw-${name}`) as HTMLInputElement | null
    el?.addEventListener('change', () => {
      void writeSetting(name, !!el.checked, [el])
    })
  })

  const statsSelect = $('sel-showSessionStats') as HTMLSelectElement | null
  statsSelect?.addEventListener('change', () => {
    void writeSetting('showSessionStats', statsSelect.value, [statsSelect])
  })

  const seg = $('detail-seg')
  if (seg) {
    DETAIL_LEVEL_ENTRIES.forEach(([value, label]) => {
      const button = document.createElement('button')
      button.setAttribute('type', 'button')
      button.setAttribute('data-detail', value)
      button.textContent = label
      button.addEventListener('click', () => {
        const buttons = Array.prototype.slice.call(seg.children) as HTMLButtonElement[]
        void writeSetting('detailLevel', value, buttons)
      })
      seg.appendChild(button)
    })
  }
}

export function wireActionButtons(
  onRender: (snapshot: PresencePanelSnapshot) => void,
  onRefresh: () => Promise<void>
): void {
  const forceRefresh = () => {
    const button = $('btn-refresh') as HTMLButtonElement | null
    if (!button || button.disabled) return Promise.resolve()
    setBusy(button, true)
    setClass(button, 'spin', true)
    const done = () => {
      setBusy(button, false)
      setClass(button, 'spin', false)
    }
    return request<PresencePanelSnapshot>('presence.refresh', {}).then(
      (snapshot) => {
        done()
        onRender(snapshot)
      },
      (error) => {
        done()
        flash(`Refresh failed: ${errorText(error)}`)
      }
    )
  }

  const run = (command: string, doneMessage: string) =>
    request<{ ok?: boolean; message?: string }>('presence.run', { command }).then(
      (result) => {
        flash(result && result.ok === false ? result.message || 'Command failed.' : doneMessage)
        return onRefresh()
      },
      (error) => {
        flash(`Command failed: ${errorText(error)}`)
      }
    )

  $('btn-refresh')?.addEventListener('click', () => void forceRefresh())
  $('btn-status')?.addEventListener('click', () => void run('presence.status', 'Status sent as a notification.'))
  $('btn-toggle')?.addEventListener('click', () => void run('presence.toggle', 'Toggled presence.'))
  $('btn-reload')?.addEventListener('click', () => void run('presence.reload', 'Reloaded the Discord connection.'))
  $('btn-clear')?.addEventListener('click', () => void run('presence.clear', 'Presence cleared until the next event.'))
}

export function wireLogs(): void {
  $('btn-log-clear')?.addEventListener('click', () => {
    const logEl = $('log-view')
    if (logEl) logEl.textContent = ''
    flash('Cleared this view only (not the on-disk log).')
  })

  $('btn-log-copy')?.addEventListener('click', () => {
    const logEl = $('log-view')
    if (!logEl) return
    const text = logEl.textContent || ''
    const selectLogs = () => {
      if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') return false
      const range = document.createRange()
      range.selectNodeContents(logEl)
      const sel = window.getSelection()
      if (!sel) return false
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    }
    // Why: isolated frames allow synchronous execCommand('copy') inside a user
    // click gesture even when navigator.clipboard.writeText is blocked.
    let copiedSync = false
    try {
      if (selectLogs() && typeof document.execCommand === 'function') {
        copiedSync = !!document.execCommand('copy')
      }
    } catch {
      copiedSync = false
    }
    if (copiedSync) {
      flash('Logs copied.')
      return
    }
    const fallback = () => {
      selectLogs()
      flash('Logs selected \u2014 copy with the system shortcut.')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flash('Logs copied.'), fallback)
    } else {
      fallback()
    }
  })

  const saveBtn = $('btn-log-save')
  const files = getOrca()?.files
  if (saveBtn && files && typeof files.saveAs === 'function') {
    setClass(saveBtn, 'hidden', false)
    saveBtn.addEventListener('click', () => {
      const text = $('log-view')?.textContent || ''
      Promise.resolve()
        .then(() =>
          files.saveAs!({
            suggestedName: 'discord-presence.log',
            mimeType: 'text/plain',
            data: text
          })
        )
        .then(
          (result) => flash(result && result.status === 'saved' ? 'Logs saved.' : 'Save cancelled.'),
          (error) => flash(`Save failed: ${errorText(error)}`)
        )
    })
  }
}
