import newOrderSound from "@food/assets/audio/new_order.mp3"

/**
 * Ring tones for the admin alert centre.
 *
 * A new order plays the recording in new_order.mp3. Everything else is synthesised
 * with Web Audio: nothing to download before the first ring, and each kind of event
 * gets a tone an operator learns to tell apart without looking (a ride beeps, an
 * SOS wails). The order chime in PATTERNS is what plays if the recording cannot.
 *
 * Chrome keeps an AudioContext suspended until the page has had a click or a
 * key press. `unlock()` is called from the first one; until then `isUnlocked()`
 * is false and the centre shows a "turn on sound" bar.
 */

// [frequency Hz, start s, duration s]
const PATTERNS = {
  order: [[880, 0, 0.16], [1175, 0.2, 0.32]],
  booking: [[784, 0, 0.14], [988, 0.18, 0.14], [1175, 0.36, 0.28]],
  ride: [[988, 0, 0.1], [988, 0.16, 0.1], [1319, 0.32, 0.24]],
  cancelled: [[660, 0, 0.18], [440, 0.24, 0.32]],
  partner: [[740, 0, 0.14], [988, 0.2, 0.24]],
  payout: [[698, 0, 0.14], [880, 0.2, 0.24]],
  support: [[659, 0, 0.14], [784, 0.2, 0.24]],
  sos: [[960, 0, 0.22], [640, 0.25, 0.22], [960, 0.5, 0.22], [640, 0.75, 0.22]],
}

/** Seconds between repeats of a ringing alert. */
export const REPEAT_SECONDS = { sos: 1.1, order: 11, default: 1.6 }

let ctx = null
const getContext = () => {
  if (ctx) return ctx
  const Ctor = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)
  if (!Ctor) return null
  ctx = new Ctor()
  return ctx
}

export const isSupported = () => Boolean(typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext))

export const isUnlocked = () => Boolean(ctx && ctx.state === "running")

/** Resume audio after a user gesture. Resolves true once sound can play. */
export async function unlock() {
  const c = getContext()
  if (!c) return false
  try {
    if (c.state !== "running") await c.resume()
  } catch {
    return false
  }
  return c.state === "running"
}

/*
 * One player for the whole admin panel. The alert centre and the Orders page both
 * announce a new order, and two copies of a song a moment apart is an echo, so a
 * second call while it is already playing does nothing.
 */
let orderAudio = null

/** Resolves true once the new-order recording is playing. Volume 0..1. */
export async function playOrderSound(volume = 0.8) {
  if (typeof Audio === "undefined") return false
  if (!orderAudio) {
    orderAudio = new Audio(newOrderSound)
    orderAudio.preload = "auto"
  }
  orderAudio.volume = Math.max(0, Math.min(1, Number(volume) || 0))
  if (!orderAudio.paused && !orderAudio.ended) return true
  try {
    orderAudio.currentTime = 0
    await orderAudio.play()
    return true
  } catch {
    return false
  }
}

/** Cuts the recording off, for when the order has been acknowledged. */
export function stopOrderSound() {
  if (!orderAudio) return
  orderAudio.pause()
  orderAudio.currentTime = 0
}

/** Play one pass of a kind's tone. Volume 0..1. Silently does nothing while locked. */
export function playTone(kind = "order", volume = 0.8) {
  const c = getContext()
  if (!c || c.state !== "running") return false
  const peak = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.6
  if (peak <= 0) return false
  if (kind === "order") {
    playOrderSound(volume).then((played) => {
      if (!played) playPattern(c, kind, peak)
    })
    return true
  }
  playPattern(c, kind, peak)
  return true
}

function playPattern(c, kind, peak) {
  const pattern = PATTERNS[kind] || PATTERNS.order
  const now = c.currentTime + 0.02
  for (const [freq, start, dur] of pattern) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = kind === "sos" ? "sawtooth" : "triangle"
    osc.frequency.setValueAtTime(freq, now + start)
    gain.gain.setValueAtTime(0.0001, now + start)
    gain.gain.exponentialRampToValueAtTime(peak, now + start + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur)
    osc.connect(gain).connect(c.destination)
    osc.start(now + start)
    osc.stop(now + start + dur + 0.05)
  }
}

/** Which ringing alert wins when several are active: the most urgent. */
export const KIND_PRIORITY = ["sos", "order", "ride", "booking", "cancelled", "partner", "payout", "support"]
