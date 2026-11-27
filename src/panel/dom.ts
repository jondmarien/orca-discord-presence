/**
 * Minimal DOM mutation and pure formatting helpers for the sandboxed panel.
 *
 * Uses `className` splitting rather than `classList.contains` so minimal DOM
 * shims in unit tests and real browsers behave identically.
 *
 * @module panel/dom
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { STATE_FILES, STATES, type PanelState } from './sections'

export function $(id: string): HTMLElement | null {
  return document.getElementById(id)
}

/** Write `textContent` only when it actually changed to avoid unnecessary reflows. */
export function setText(id: string, value: unknown, fallback = ''): void {
  const el = $(id)
  const next = value == null || value === '' ? fallback : String(value)
  if (el && el.textContent !== next) {
    el.textContent = next
  }
}

export function setAttr(el: Element | null, name: string, value: string): void {
  if (el && el.getAttribute(name) !== value) {
    el.setAttribute(name, value)
  }
}

export function hasClass(el: Element | null, name: string): boolean {
  return !!el && (` ${el.className} `).includes(` ${name} `)
}

export function setClass(el: Element | null, name: string, on: boolean): void {
  if (el && !hasClass(el, name) === !!on) {
    el.classList.toggle(name, !!on)
  }
}

export function clearChildren(el: Element | null): void {
  if (!el) return
  while (el.firstChild) {
    el.removeChild(el.firstChild)
  }
}

export function setBusy(el: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, busy: boolean): void {
  el.disabled = busy
  el.setAttribute('aria-busy', busy ? 'true' : 'false')
}

export function flash(message: string): void {
  setText('flash', message)
}

export function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const rec = error as { message?: unknown; code?: unknown }
    if (typeof rec.message === 'string' && rec.message) return rec.message
    if (typeof rec.code === 'string' && rec.code) return rec.code
  }
  return 'error'
}

/** Orca's `done` is displayed as `completed`; the snapshot keeps the raw name. */
export function displayState(state: string): string {
  return state === 'done' ? 'completed' : state
}

export function normalizeState(state: string): PanelState | 'none' {
  return (STATES as readonly string[]).includes(state) ? (state as PanelState) : 'none'
}

export function stateImage(state: string): string {
  const file = (STATE_FILES as Record<string, string | undefined>)[state] ?? STATE_FILES.idle
  return `../assets/${file}.png`
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

export function formatSince(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
