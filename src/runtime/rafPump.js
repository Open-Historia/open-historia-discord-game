/*! Open Historia — Discord edition: headless render pump. © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// A hidden/background page — Playwright's headless Chromium (the bot bridge), an
// offscreen iframe, an embedded live-map view — pauses requestAnimationFrame.
// That freezes MapLibre's render loop: tiles never finish, the map never emits
// 'idle', and it reads back blank. A MessageChannel is NOT throttled by page
// visibility, so we drive frames through one instead.
//
// Two callers, two policies:
//   - Bot bridge  (force: true)  -> ALWAYS pump. Playwright is unreliable about
//     visibility/rAF, and the page is never actually watched, so vsync is moot.
//   - Spectator   (force: false) -> pump ONLY while document.hidden. A real
//     spectator watching in a foreground tab keeps native, vsync-paced rAF; a
//     hidden/embedded render still gets frames.
// Frames are only pumped while callbacks are queued, so a settled map costs nothing.
let installed = false;
// Namespace our ids well above native rAF ids so cancelAnimationFrame can tell
// which mechanism a handle came from.
const ID_BASE = 1e9;

export function installRafPump({ force = false } = {}) {
  if (installed || typeof window === "undefined" || typeof MessageChannel === "undefined") {
    return;
  }
  installed = true;

  const nativeRaf = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame.bind(window) : null;
  const nativeCancel = typeof window.cancelAnimationFrame === "function" ? window.cancelAnimationFrame.bind(window) : null;

  const channel = new MessageChannel();
  let queue = [];
  let nextId = 1;
  let flushing = false;

  const pump = () => {
    if (!flushing && queue.length) {
      flushing = true;
      channel.port2.postMessage(0);
    }
  };

  channel.port1.onmessage = () => {
    flushing = false;
    const now = performance.now();
    const batch = queue;
    queue = [];
    for (const entry of batch) {
      try {
        entry.cb(now);
      } catch {
        /* one bad frame callback must not stop the pump */
      }
    }
    if (queue.length) pump();
  };

  // Delegate to real vsync-paced rAF when we can (spectator, foreground tab).
  const canUseNative = () => !force && nativeRaf && typeof document !== "undefined" && !document.hidden;

  window.requestAnimationFrame = (cb) => {
    if (canUseNative()) return nativeRaf(cb);
    const id = ID_BASE + nextId++;
    queue.push({ id, cb });
    pump();
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (id >= ID_BASE) queue = queue.filter((entry) => entry.id !== id);
    else if (nativeCancel) nativeCancel(id);
  };
}
