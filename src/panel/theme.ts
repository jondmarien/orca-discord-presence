/**
 * Panel light/dark theme synchronization (`html.light`/`.dark` seed, host
 * `theme` `{ colorScheme }` event, and `panelTheme` storage fallback).
 *
 * @module panel/theme
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { hasClass, setAttr } from './dom'
import { callHost, getOrca, storedValue } from './host-bridge'

const THEME_KEY = 'panelTheme'
let themeFromEvent = false

export function themeOf(payload: unknown): 'light' | 'dark' | null {
  let theme: unknown
  if (typeof payload === 'string') {
    theme = payload
  } else if (payload && typeof payload === 'object') {
    const obj = payload as { colorScheme?: unknown; theme?: unknown; mode?: unknown }
    theme = obj.colorScheme || obj.theme || obj.mode
  }
  return theme === 'light' || theme === 'dark' ? theme : null
}

export function seedInitialTheme(): void {
  const root = document.documentElement
  if (!root) return
  if (hasClass(root, 'light')) setAttr(root, 'data-theme', 'light')
  else if (hasClass(root, 'dark')) setAttr(root, 'data-theme', 'dark')
}

export function applyTheme(payload: unknown): void {
  const theme = themeOf(payload)
  if (!theme) return
  themeFromEvent = true
  setAttr(document.documentElement, 'data-theme', theme)
  callHost('storage.set', { key: THEME_KEY, value: theme })
}

export function loadTheme(): Promise<void> {
  const host = getOrca()?.host
  if (!host || typeof host.call !== 'function') return Promise.resolve()
  return Promise.resolve()
    .then(() => host.call!('storage.get', { key: THEME_KEY }))
    .then(
      (result) => {
        const theme = themeOf(storedValue(result))
        if (theme && !themeFromEvent) setAttr(document.documentElement, 'data-theme', theme)
      },
      () => {}
    )
}

export function wireTheme(): void {
  void loadTheme()
  const orca = getOrca()
  if (orca && typeof orca.on === 'function') {
    try {
      orca.on('theme', applyTheme)
    } catch {
      // Why: older hosts reject unknown events; frame variables still theme the panel.
    }
  }
}
