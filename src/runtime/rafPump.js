/*! Open Historia — Discord edition: headless render pump. © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// Bot mode only. A hidden/background tab — Playwright's headless Chromium, an
// offscreen iframe — pauses requestAnimationFrame. That freezes MapLibre's
// render loop: tiles never finish decoding, the map never emits 'idle', the
// first-world-idle hook never fires (so window.oh never installs), and
// getCanvas().toDataURL() reads back a blank frame. A MessageChannel is NOT
// throttled by page visibility, so we drive frames through one instead. Frames
// are only pumped while callbacks are queued, so a settled map costs nothing.
let installed = false;

export function installRafPump() {
  if (installed || typeof window === "undefined" || typeof MessageChannel === "undefined") {
    return;
  }
  installed = true;

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
    // Callbacks that requested another frame (a continuing animation, more tiles
    // to draw) queued into the fresh array — keep pumping until it drains.
    if (queue.length) pump();
  };

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.push({ id, cb });
    pump();
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queue = queue.filter((entry) => entry.id !== id);
  };
}
