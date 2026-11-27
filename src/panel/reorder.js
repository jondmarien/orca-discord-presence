// Pure Pointer Events vertical block reordering for the Orca isolated panel.
// Inlined before panel.js inside the single panel IIFE (zero dependencies).
// Mechanics adapted from mswdev/orca-fleet-monitor (PRs #7 & #8): root pointer
// capture, dragstart suppression, midpoint hysteresis for unequal heights,
// scroll-jump protection, time-based edge auto-scroll, FLIP sibling slides,
// Escape/cancel rollback, and Alt+Arrow keyboard fallback.

var REORDER_DRAG_PX = 5
var REORDER_TOUCH_HOLD_MS = 350
var REORDER_TOUCH_SLOP_PX = 10
var REORDER_DROP_MS = 180
var REORDER_EDGE_PX = 48
var REORDER_SCROLL_PX_PER_MS = 14 / 16.7
var REORDER_REVEAL_PX = 8
var REORDER_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

function reconcileOrder(saved, defaults) {
  var known = {}
  for (var i = 0; i < defaults.length; i += 1) {
    known[defaults[i]] = true
  }
  var seen = {}
  var out = []
  if (Array.isArray(saved)) {
    for (var j = 0; j < saved.length; j += 1) {
      var id = typeof saved[j] === 'string' ? saved[j].trim() : ''
      if (id && known[id] && !seen[id]) {
        seen[id] = true
        out.push(id)
      }
    }
  }
  for (var k = 0; k < defaults.length; k += 1) {
    if (!seen[defaults[k]]) {
      out.push(defaults[k])
    }
  }
  return out
}

function mergeVisibleOrder(visibleIds, fullOrder) {
  var visibleSet = {}
  for (var i = 0; i < visibleIds.length; i += 1) {
    visibleSet[visibleIds[i]] = true
  }
  var next = fullOrder.slice()
  var cursor = 0
  for (var j = 0; j < next.length; j += 1) {
    if (visibleSet[next[j]] && cursor < visibleIds.length) {
      next[j] = visibleIds[cursor]
      cursor += 1
    }
  }
  while (cursor < visibleIds.length) {
    if (next.indexOf(visibleIds[cursor]) === -1) {
      next.push(visibleIds[cursor])
    }
    cursor += 1
  }
  return next
}

function movedIds(ids, id, toIndex) {
  var from = ids.indexOf(id)
  if (from === -1) return ids.slice()
  var to = Math.max(0, Math.min(ids.length - 1, toIndex))
  if (to === from) return ids.slice()
  var next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

// Midpoint hysteresis using layout offsetTop/offsetHeight (ignores CSS transform).
// Only swaps past the neighbor's vertical midpoint in the direction of travel,
// so short blocks (actions) and tall blocks (toggles/logs) never oscillate.
function targetIndex(items, activeItem, pointerY) {
  var from = items.indexOf(activeItem)
  if (from === -1) return -1
  for (var i = 0; i < items.length; i += 1) {
    if (i === from) continue
    var item = items[i]
    var top = item.offsetTop
    var height = item.offsetHeight
    if (pointerY < top || pointerY > top + height) continue
    var mid = top + height / 2
    if (i > from && pointerY >= mid) return i
    if (i < from && pointerY <= mid) return i
    return from
  }
  return from
}

function createBlockReorder(options) {
  var container = options.container
  var doc = options.doc || document
  var win = options.win || window
  var getVisibleBlocks = options.getVisibleBlocks
  var getLabel = options.getLabel
  var applyDomOrder = options.applyDomOrder
  var onCommit = options.onCommit
  var onAnnounce = options.onAnnounce
  var getOrder = options.getOrder
  var motionOn =
    options.motion ||
    function () {
      return !(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    }
  var later =
    options.later ||
    function (fn, ms) {
      return setTimeout(fn, ms)
    }
  var cancelLater =
    options.cancelLater ||
    function (id) {
      clearTimeout(id)
    }
  var reqFrame =
    options.frame ||
    function (fn) {
      return typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : later(function () { fn(Date.now()) }, 16)
    }
  var cancelFrame =
    options.cancelFrame ||
    function (id) {
      if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id)
      else cancelLater(id)
    }

  var press = null
  var drag = null
  var suppressClickUntil = 0

  function closestMatching(node, attr) {
    var cur = node
    while (cur && cur !== container) {
      if (typeof cur.getAttribute === 'function' && cur.getAttribute(attr) != null) return cur
      cur = cur.parentNode
    }
    return null
  }

  function containerOriginY() {
    if (typeof container.getBoundingClientRect === 'function') {
      return container.getBoundingClientRect().top
    }
    return 0
  }

  function blockById(id) {
    var blocks = getVisibleBlocks()
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].getAttribute('data-block') === id) return blocks[i]
    }
    return null
  }

  function clampDeltaY(el, rawDy) {
    var minDy = -el.offsetTop
    var containerH = container.offsetHeight || 0
    var maxDy = containerH > 0 ? Math.max(0, containerH - (el.offsetTop + el.offsetHeight)) : rawDy
    if (rawDy < minDy) return minDy
    if (rawDy > maxDy) return maxDy
    return rawDy
  }

  function applyLiftTransform() {
    if (!drag) return
    var el = blockById(drag.id)
    if (!el) return
    var pointerInContainer = drag.clientY - containerOriginY()
    var desiredTop = pointerInContainer - drag.grabOffsetY
    var dy = clampDeltaY(el, desiredTop - el.offsetTop)
    el.setAttribute('data-dragging', '')
    el.style.transform = 'translateY(' + Math.round(dy) + 'px)'
  }

  function animateFlip(beforeTops, skipId) {
    if (!motionOn()) return
    var blocks = getVisibleBlocks()
    for (var i = 0; i < blocks.length; i += 1) {
      var el = blocks[i]
      var id = el.getAttribute('data-block')
      if (!id || id === skipId) continue
      if (beforeTops[id] === undefined) continue
      var dy = beforeTops[id] - el.offsetTop
      if (Math.abs(dy) < 1) continue
      if (typeof el.animate === 'function') {
        try {
          el.animate(
            [{ transform: 'translateY(' + dy + 'px)' }, { transform: 'translateY(0px)' }],
            { duration: REORDER_DROP_MS, easing: REORDER_EASE }
          )
        } catch (err) {}
      }
    }
  }

  function snapshotTops() {
    var tops = {}
    var blocks = getVisibleBlocks()
    for (var i = 0; i < blocks.length; i += 1) {
      var id = blocks[i].getAttribute('data-block')
      if (id) tops[id] = blocks[i].offsetTop
    }
    return tops
  }

  function reorderInPlace(nextOrder, skipFlipId) {
    var beforeTops = snapshotTops()
    var savedScrollY = typeof win.scrollY === 'number' ? win.scrollY : 0
    var logEl = doc.getElementById ? doc.getElementById('log-view') : null
    var savedLogScroll = logEl && typeof logEl.scrollTop === 'number' ? logEl.scrollTop : null
    applyDomOrder(nextOrder)
    if (savedLogScroll !== null && logEl && logEl.scrollTop !== savedLogScroll) {
      logEl.scrollTop = savedLogScroll
    }
    if (typeof win.scrollTo === 'function' && typeof win.scrollY === 'number' && win.scrollY !== savedScrollY) {
      win.scrollTo(0, savedScrollY)
    }
    animateFlip(beforeTops, skipFlipId)
  }

  function stopAutoScroll() {
    if (drag && drag.scrollRaf != null) {
      cancelFrame(drag.scrollRaf)
      drag.scrollRaf = null
      drag.scrollLastTs = 0
    }
  }

  function stepAutoScroll(ts) {
    if (!drag) return
    drag.scrollRaf = null
    var vh = win.innerHeight || 0
    if (vh <= 0 || typeof win.scrollBy !== 'function') return
    var dir = 0
    var ratio = 0
    if (drag.clientY < REORDER_EDGE_PX) {
      dir = -1
      ratio = Math.min(1, (REORDER_EDGE_PX - drag.clientY) / REORDER_EDGE_PX)
    } else if (drag.clientY > vh - REORDER_EDGE_PX) {
      dir = 1
      ratio = Math.min(1, (drag.clientY - (vh - REORDER_EDGE_PX)) / REORDER_EDGE_PX)
    }
    if (!dir) {
      drag.scrollLastTs = 0
      return
    }
    var dt = drag.scrollLastTs ? Math.min(48, Math.max(0, ts - drag.scrollLastTs)) : 16
    drag.scrollLastTs = ts
    win.scrollBy(0, dir * REORDER_SCROLL_PX_PER_MS * dt * (0.4 + 0.6 * ratio))
    updateDragPosition()
    drag.scrollRaf = reqFrame(stepAutoScroll)
  }

  function ensureAutoScroll() {
    if (!drag || drag.scrollRaf != null) return
    var vh = win.innerHeight || 0
    if (vh <= 0) return
    if (drag.clientY < REORDER_EDGE_PX || drag.clientY > vh - REORDER_EDGE_PX) {
      drag.scrollLastTs = 0
      drag.scrollRaf = reqFrame(stepAutoScroll)
    }
  }

  function clearPress() {
    if (!press) return
    if (press.timer != null) {
      cancelLater(press.timer)
    }
    press = null
  }

  function beginDrag(p) {
    var visible = getVisibleBlocks()
    if (visible.length < 2) {
      clearPress()
      return
    }
    var el = blockById(p.id)
    if (!el) {
      clearPress()
      return
    }
    var visibleIds = visible.map(function (b) {
      return b.getAttribute('data-block')
    })
    var fullOrder = getOrder().slice()
    drag = {
      id: p.id,
      pointerId: p.pointerId,
      pointerType: p.pointerType,
      clientY: p.clientY,
      grabOffsetY: p.startClientY - containerOriginY() - el.offsetTop,
      startFullOrder: fullOrder,
      currentFullOrder: fullOrder,
      startVisibleIds: visibleIds,
      currentVisibleIds: visibleIds,
      scrollRaf: null,
      scrollLastTs: 0
    }
    clearPress()
    container.setAttribute('data-reordering', '')
    if (typeof container.setPointerCapture === 'function') {
      try {
        container.setPointerCapture(drag.pointerId)
      } catch (err) {}
    }
    applyLiftTransform()
    ensureAutoScroll()
  }

  function updateDragPosition() {
    if (!drag) return
    var visible = getVisibleBlocks()
    var el = blockById(drag.id)
    if (!el || visible.length < 2) {
      finish(false)
      return
    }
    var pointerInContainer = drag.clientY - containerOriginY()
    var nextIdx = targetIndex(visible, el, pointerInContainer)
    var currentIdx = visible.indexOf(el)
    if (nextIdx >= 0 && nextIdx !== currentIdx) {
      var nextVisible = movedIds(drag.currentVisibleIds, drag.id, nextIdx)
      var nextFull = mergeVisibleOrder(nextVisible, drag.currentFullOrder)
      drag.currentVisibleIds = nextVisible
      drag.currentFullOrder = nextFull
      reorderInPlace(nextFull, drag.id)
    }
    applyLiftTransform()
  }

  function finish(commit) {
    if (!drag) return false
    var active = drag
    stopAutoScroll()
    drag = null
    suppressClickUntil = Date.now() + 250
    container.removeAttribute('data-reordering')
    if (typeof container.releasePointerCapture === 'function') {
      try {
        container.releasePointerCapture(active.pointerId)
      } catch (err) {}
    }
    var el = blockById(active.id)
    var prevTransform = el ? el.style.transform : ''
    if (!commit) {
      reorderInPlace(active.startFullOrder, active.id)
    }
    el = blockById(active.id)
    if (el) {
      el.removeAttribute('data-dragging')
      el.style.transform = ''
      if (motionOn() && prevTransform && typeof el.animate === 'function') {
        try {
          el.animate([{ transform: prevTransform }, { transform: 'translateY(0px)' }], {
            duration: REORDER_DROP_MS,
            easing: REORDER_EASE
          })
        } catch (err) {}
      }
    }
    var changed = active.currentFullOrder.join(',') !== active.startFullOrder.join(',')
    if (commit && changed) {
      onCommit(active.currentFullOrder)
      var idx = active.currentVisibleIds.indexOf(active.id)
      if (idx !== -1 && onAnnounce) {
        onAnnounce(getLabel(active.id) + ', position ' + (idx + 1) + ' of ' + active.currentVisibleIds.length)
      }
    }
    return true
  }

  function revealBlock(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function' || typeof win.scrollBy !== 'function') return
    var rect = el.getBoundingClientRect()
    var vh = win.innerHeight || 0
    if (vh <= 0) return
    if (rect.top < REORDER_REVEAL_PX) {
      win.scrollBy(0, rect.top - REORDER_REVEAL_PX)
    } else if (rect.bottom > vh - REORDER_REVEAL_PX) {
      win.scrollBy(0, rect.bottom - (vh - REORDER_REVEAL_PX))
    }
  }

  function moveByKeyboard(id, delta) {
    if (drag) return false
    var visible = getVisibleBlocks()
    var visibleIds = visible.map(function (b) {
      return b.getAttribute('data-block')
    })
    var at = visibleIds.indexOf(id)
    var to = Math.max(0, Math.min(visibleIds.length - 1, at + delta))
    if (at === -1 || to === at) return false
    var nextVisible = movedIds(visibleIds, id, to)
    var nextFull = mergeVisibleOrder(nextVisible, getOrder())
    reorderInPlace(nextFull, null)
    onCommit(nextFull)
    var movedEl = blockById(id)
    var handle =
      movedEl && typeof movedEl.querySelector === 'function'
        ? movedEl.querySelector('[data-drag-handle]')
        : doc.querySelector
          ? doc.querySelector('[data-drag-handle="' + id + '"]')
          : null
    if (handle && typeof handle.focus === 'function') {
      try {
        handle.focus({ preventScroll: true })
      } catch (err) {
        handle.focus()
      }
    }
    revealBlock(movedEl)
    if (onAnnounce) {
      onAnnounce(getLabel(id) + ', position ' + (to + 1) + ' of ' + nextVisible.length)
    }
    return true
  }

  container.addEventListener('dragstart', function (event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
  })

  container.addEventListener('contextmenu', function (event) {
    if ((press && press.pointerType === 'touch') || drag) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
    }
  })

  container.addEventListener('pointerdown', function (event) {
    if (!event) return
    if (event.isPrimary === false) return
    if (typeof event.button === 'number' && event.button !== 0) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    var handle = closestMatching(event.target, 'data-drag-handle')
    if (!handle) return
    var id = handle.getAttribute('data-drag-handle')
    if (!id) return
    if (getVisibleBlocks().length < 2) return
    clearPress()
    press = {
      id: id,
      pointerId: event.pointerId == null ? 1 : event.pointerId,
      pointerType: event.pointerType || 'mouse',
      startClientX: event.clientX || 0,
      startClientY: event.clientY || 0,
      clientY: event.clientY || 0,
      timer: null
    }
    if (press.pointerType === 'touch') {
      var captured = press
      press.timer = later(function () {
        if (press === captured) beginDrag(captured)
      }, REORDER_TOUCH_HOLD_MS)
    }
  })

  container.addEventListener('pointermove', function (event) {
    if (!event) return
    var pid = event.pointerId == null ? 1 : event.pointerId
    if (event.pointerType === 'mouse' && typeof event.buttons === 'number' && event.buttons === 0) {
      clearPress()
      if (drag) finish(true)
      return
    }
    if (drag && drag.pointerId === pid) {
      drag.clientY = event.clientY || 0
      updateDragPosition()
      ensureAutoScroll()
      return
    }
    if (press && press.pointerId === pid) {
      var dx = (event.clientX || 0) - press.startClientX
      var dy = (event.clientY || 0) - press.startClientY
      var dist = Math.sqrt(dx * dx + dy * dy)
      press.clientY = event.clientY || 0
      if (press.pointerType === 'touch') {
        if (dist > REORDER_TOUCH_SLOP_PX) clearPress()
      } else if (dist >= REORDER_DRAG_PX) {
        beginDrag(press)
        if (drag) {
          drag.clientY = event.clientY || 0
          updateDragPosition()
        }
      }
    }
  })

  container.addEventListener('pointerup', function (event) {
    var pid = event && event.pointerId != null ? event.pointerId : 1
    if (press && press.pointerId === pid) clearPress()
    if (drag && drag.pointerId === pid) finish(true)
  })

  container.addEventListener('pointercancel', function (event) {
    var pid = event && event.pointerId != null ? event.pointerId : 1
    if (press && press.pointerId === pid) clearPress()
    if (drag && drag.pointerId === pid) finish(false)
  })

  container.addEventListener(
    'touchmove',
    function (event) {
      if (drag && event && typeof event.preventDefault === 'function') {
        event.preventDefault()
      }
    },
    { passive: false }
  )

  container.addEventListener('keydown', function (event) {
    if (!event || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    var delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (!delta) return
    var handle = closestMatching(event.target, 'data-drag-handle')
    if (!handle) return
    var id = handle.getAttribute('data-drag-handle')
    if (!id) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    moveByKeyboard(id, delta)
  })

  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('keydown', function (event) {
      if (event && event.key === 'Escape' && drag) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        finish(false)
      }
    })
  }

  if (typeof win.addEventListener === 'function') {
    win.addEventListener('blur', function () {
      clearPress()
      if (drag) finish(false)
    })
    win.addEventListener('scroll', function () {
      if (drag) updateDragPosition()
    })
  }

  return {
    dragging: function () {
      return !!drag
    },
    cancel: function () {
      clearPress()
      return finish(false)
    },
    sync: function () {
      if (!drag) return
      if (!blockById(drag.id)) {
        finish(false)
        return
      }
      applyLiftTransform()
    },
    consumeClick: function (event) {
      if (event && event.detail === 0) return false
      return Date.now() < suppressClickUntil
    },
    moveByKeyboard: moveByKeyboard
  }
}
