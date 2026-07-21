/*! Open Historia — read-only spectator flag © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// Discord edition. COSMETIC / defense-in-depth ONLY. A spectator can strip
// ?spectator=1 from the URL and every write control returns — nothing here is a
// security boundary. The actual boundary is topological: the writable game port
// is bound to loopback (server.js honours HOST=127.0.0.1) behind a read-only
// GET/HEAD/OPTIONS proxy (the bot repo's spectator-proxy.mjs), so no write ever
// reaches Express from the internet regardless of this flag. This only hides
// write affordances so a "watch my game" link never dangles a Shut Down / Jump /
// Deploy control in front of a viewer.
let cached = null;

export const isSpectator = () => {
  if (cached !== null) return cached;
  try {
    cached =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("spectator");
  } catch {
    cached = false;
  }
  return cached;
};
