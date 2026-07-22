/*! Open Historia — Discord edition: headless bot host. © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
// Reached only via ?bot=1 (App.jsx). Renders the REAL game (GameApp bot) so the
// live MapLibre map, the game UI, the world/units pollers and idle diplomacy all
// mount and run exactly as in normal play, then installs a window.oh control
// surface that wraps the existing gameplay.js / gameState.js exports. A separate
// bot process (the Discord bridge) drives this page through window.oh over a
// loopback Playwright connection. All map access goes through the raw MapLibre
// handle from mapRef.current.getMap() — never by walking React fibers.
import { useCallback, useEffect, useRef } from "react";
import { GameApp } from "../App.jsx";
import {
  advanceActiveCatalyst,
  applyGameMasterCommand,
  generateActionSuggestions,
  generateCountryStats,
  generateCountryStatSheet,
  isSimulationBusy,
  loadRollbackSnapshots,
  refinePlayerAction,
  rollBackToSnapshot,
  simulateAutoJump,
  simulateTimelineJump,
} from "../Game/AI/gameplay.js";
import {
  normalizeActionEntry,
  readActionsState,
  readChatsState,
  readEventsState,
  readGameData,
  readGameStateBundle,
  readWorldState,
  writeActionsState,
  writeChatsState,
  writeGameData,
  writeWorldState,
} from "./gameState.js";
import {
  loadDiplomaticHistory,
  sendDiplomaticMessage,
  startDiplomaticChat,
} from "../Game/AI/main.jsx";
import { loadRegionCatalog } from "./assets.js";
import { geocodePlace } from "../Game/GameUI/search.jsx";
import { installRafPump } from "./rafPump.js";

// Install the headless render pump the moment the bot chunk loads — before
// GameApp mounts the MapLibre map — so the map renders and reaches 'idle' even
// though a headless/background page has requestAnimationFrame paused. force:true
// because Playwright's page is never actually watched and is unreliable about
// reporting visibility.
installRafPump({ force: true });

// --- serialization -----------------------------------------------------------
// Every mutating oh.* call runs through this single promise chain, so the bot
// controller can fire calls without awaiting each and they never interleave. On
// top of the chain, each op refuses to start while the engine's OWN lock is held
// (a jump/catalyst/game-master command, or the autonomous idle-diplomacy drip):
// it spin-waits out the in-flight simulation, then throws if it never clears.
let _opChain = Promise.resolve();
const _serialize = (label, fn) => {
  const run = async () => {
    for (let i = 0; i < 600 && isSimulationBusy(); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isSimulationBusy()) {
      throw new Error(`oh.${label}: engine busy (timed out waiting for the simulation lock)`);
    }
    return fn();
  };
  const next = _opChain.then(run, run);
  _opChain = next.catch(() => {});
  return next;
};

// --- region / map helpers ----------------------------------------------------
// Stock games paint from the "regions-source" vector tiles; custom-map games use
// the "custom-regions-source" geojson. Both key regions on GID_1, so try each.
const REGION_SOURCES = [
  { source: "regions-source", sourceLayer: "regions" },
  { source: "custom-regions-source", sourceLayer: null },
];

const queryRegionFeatures = (map, id) => {
  if (!map || !id) return [];
  for (const { source, sourceLayer } of REGION_SOURCES) {
    try {
      const opts = { filter: ["==", ["get", "GID_1"], String(id)] };
      if (sourceLayer) opts.sourceLayer = sourceLayer;
      const feats = map.querySourceFeatures(source, opts);
      if (feats && feats.length) return feats;
    } catch {
      /* that source isn't in the current style — try the next */
    }
  }
  return [];
};

const bboxOfFeatures = (feats) => {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const walk = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords) walk(c);
  };
  for (const f of feats) {
    if (f?.geometry?.coordinates) walk(f.geometry.coordinates);
  }
  if (minLng === Infinity) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
};

// Resolve when the map settles, but never hang the RPC: 'idle' can fail to fire
// if nothing needs repainting, so cap the wait.
const waitForIdle = (map, timeoutMs = 8000) =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      map.once("idle", finish);
      map.triggerRepaint?.();
    } catch {
      finish();
    }
    setTimeout(finish, timeoutMs);
  });

// --- result summarizers (keep RPC payloads small) ----------------------------
const summarizeEvent = (e) => ({
  id: e.id,
  date: e.date,
  title: e.title,
  description: e.description,
  importance: e.importance,
  notable: !!e.notable,
  playerRelated: !!e.playerRelated,
  mapChange:
    (e.impacts?.regionTransfers?.length || 0) + (e.impacts?.polityChanges?.length || 0),
});

const summarizeCatalyst = (catalyst) =>
  catalyst
    ? {
        title: catalyst.title || "",
        opening: catalyst.opening || catalyst.summary || "",
        choices: (catalyst.choices || []).map((c) => (typeof c === "string" ? c : c.text || "")),
      }
    : null;

const summarizeResolution = (bundle, beforeIds) => {
  const events = Array.isArray(bundle?.events) ? bundle.events : [];
  const fresh = events.filter((e) => e && !beforeIds.has(e.id)).map(summarizeEvent);
  return {
    gameDate: bundle?.game?.gameDate || "",
    newEvents: fresh,
    mapChanged: fresh.some((e) => e.mapChange > 0),
    fallbackReason: bundle?.generation?.fallbackReason || "",
    activeCatalyst: summarizeCatalyst(bundle?.world?.activeCatalyst),
  };
};

// --- the window.oh surface ---------------------------------------------------
function installOhSurface(map, mapReadyPromise) {
  if (window.oh?._installed) {
    window.oh._map = map;
    window.oh._mapReady = mapReadyPromise;
    return;
  }

  const oh = {
    _installed: true,
    _map: map,
    _mapReady: mapReadyPromise,
    isBusy: () => isSimulationBusy(),

    // --- whole-state read -----------------------------------------------------
    getState: () => readGameStateBundle({ force: true }),

    // --- players / factions ---------------------------------------------------
    // The primary nation is game.country (the one the engine simulates "for").
    // The roster is world.factionNations — empty on a normal single-player world,
    // populated in multi-nation Discord games (workstream B). Reading tolerates
    // both so a pre-B world still answers.
    getActivePlayers: async () => {
      const [game, world] = await Promise.all([
        readGameData({ force: true }),
        readWorldState({ force: true }),
      ]);
      const roster = Array.isArray(world.factionNations) ? world.factionNations.slice() : [];
      return { primary: game.country || "", roster: roster.length ? roster : [game.country].filter(Boolean) };
    },
    // First entry becomes the primary game.country; the whole list is stored as
    // world.factionNations. On a pre-B build normalizeWorldState drops the field
    // (harmless — single nation); once B ships it persists and drives attribution.
    setActivePlayers: (players) =>
      _serialize("setActivePlayers", async () => {
        const list = (Array.isArray(players) ? players : [players]).map((p) => String(p || "")).filter(Boolean);
        if (list.length) {
          const game = await readGameData({ force: true });
          if (game.country !== list[0]) await writeGameData({ ...game, country: list[0] });
          const world = await readWorldState({ force: true });
          await writeWorldState({ ...world, factionNations: list });
        }
        return { primary: list[0] || "", roster: list };
      }),

    // --- action queue ---------------------------------------------------------
    // Refine raw intent through the SAME path the manual input box uses, then
    // append to the shared actions.json. ownerNation is stamped for multi-nation
    // attribution (dropped by normalize on a pre-B build — fine, one nation).
    queueActionFor: (nation, text) =>
      _serialize("queueActionFor", async () => {
        const refined = await refinePlayerAction(String(text), { persist: false });
        const game = await readGameData({ force: true });
        const owner = String(nation || game.country || "");
        const entry = normalizeActionEntry({ ...refined, ownerNation: owner, source: "bot" });
        const actions = await readActionsState({ force: true });
        await writeActionsState([...actions, entry]);
        return entry;
      }),
    listQueuedActions: async () =>
      (await readActionsState({ force: true })).filter((a) => a.status === "planned"),
    clearQueuedActions: () =>
      _serialize("clearQueuedActions", async () => {
        const actions = await readActionsState({ force: true });
        await writeActionsState(actions.filter((a) => a.status !== "planned"));
        return { cleared: true };
      }),

    // --- turn resolution (these engine fns already take the simulation lock) ---
    resolveRound: ({ days = 30 } = {}) =>
      _serialize("resolveRound", async () => {
        const before = await readEventsState({ force: true });
        const beforeIds = new Set(before.map((e) => e.id));
        const bundle = await simulateTimelineJump({ days, mode: "jump" });
        return summarizeResolution(bundle, beforeIds);
      }),
    autoResolve: ({ days = 365 } = {}) =>
      _serialize("autoResolve", async () => {
        const before = await readEventsState({ force: true });
        const beforeIds = new Set(before.map((e) => e.id));
        const bundle = await simulateAutoJump({ days });
        return summarizeResolution(bundle, beforeIds);
      }),
    gameMaster: (text) =>
      _serialize("gameMaster", async () => {
        const before = await readEventsState({ force: true });
        const beforeIds = new Set(before.map((e) => e.id));
        const bundle = await applyGameMasterCommand(String(text));
        return summarizeResolution(bundle, beforeIds);
      }),

    // --- catalysts / pending decisions ----------------------------------------
    advanceCatalyst: (choiceText) =>
      _serialize("advanceCatalyst", async () => {
        const result = await advanceActiveCatalyst(String(choiceText));
        // Either the scene continues ({ catalyst, world }) or it resolved into an
        // applySimulationResult bundle. Normalize to a small, uniform shape.
        if (result?.world?.activeCatalyst || result?.catalyst) {
          return { resolved: false, activeCatalyst: summarizeCatalyst(result.catalyst || result.world?.activeCatalyst) };
        }
        return { resolved: true, ...summarizeResolution(result, new Set()) };
      }),
    listPendingDecisions: async () => {
      const [world, chats, game] = await Promise.all([
        readWorldState({ force: true }),
        readChatsState({ force: true }),
        readGameData({ force: true }),
      ]);
      const me = String(game.country || "").toLowerCase();
      const awaiting = chats.filter(
        (c) =>
          c.status !== "closed" &&
          c.messages?.length &&
          String(c.messages.at(-1)?.speaker || "").toLowerCase() !== me &&
          c.messages.at(-1)?.role !== "user",
      );
      return {
        catalyst: summarizeCatalyst(world.activeCatalyst),
        chatsAwaitingReply: awaiting.map((c) => ({
          id: c.id,
          countries: c.countries,
          title: c.title,
          last: c.messages.at(-1),
        })),
      };
    },

    // --- diplomacy ------------------------------------------------------------
    // Generate a counterpart's reply without persisting (preview a vote option).
    generateChatReply: (chatId, text) =>
      _serialize("generateChatReply", async () => {
        const chats = await readChatsState({ force: true });
        const chat = chats.find((c) => String(c.id) === String(chatId));
        if (!chat) throw new Error("generateChatReply: no such chat");
        const game = await readGameData({ force: true });
        const me = String(game.country || "").toLowerCase();
        if (chat.messages?.length) loadDiplomaticHistory(chat.messages);
        else startDiplomaticChat();
        const speaker = chat.countries.find((c) => c.name?.toLowerCase() !== me) || chat.countries[0];
        const { reply, reaction } = await sendDiplomaticMessage(String(text), speaker.name, chat.countries);
        return { speaker: speaker.name, code: speaker.code, reply, reaction: reaction || "" };
      }),
    // Append the player's line + the generated counterpart reply, then persist
    // the whole thread (as the chat UI does).
    postChatReply: (chatId, text) =>
      _serialize("postChatReply", async () => {
        const chats = await readChatsState({ force: true });
        const idx = chats.findIndex((c) => String(c.id) === String(chatId));
        if (idx < 0) throw new Error("postChatReply: no such chat");
        const chat = chats[idx];
        const game = await readGameData({ force: true });
        const me = String(game.country || "").toLowerCase();
        if (chat.messages?.length) loadDiplomaticHistory(chat.messages);
        else startDiplomaticChat();
        const speaker = chat.countries.find((c) => c.name?.toLowerCase() !== me) || chat.countries[0];
        const { reply, reaction } = await sendDiplomaticMessage(String(text), speaker.name, chat.countries);
        const messages = [
          ...(chat.messages || []),
          { role: "user", speaker: game.country, text: String(text), time: game.gameDate || "" },
          {
            role: "leader",
            speaker: speaker.name,
            code: speaker.code || "",
            text: reply,
            time: game.gameDate || "",
            ...(reaction ? { reactions: { [reaction]: 1 } } : {}),
          },
        ];
        const next = chats.map((c, i) => (i === idx ? { ...c, messages } : c));
        await writeChatsState(next);
        return { chatId, messages };
      }),

    // --- intel / suggestions (read-only) --------------------------------------
    countryIntel: ({ code, name } = {}) => generateCountryStats({ code, name }),
    countryStatSheet: ({ code, name } = {}) => generateCountryStatSheet({ code, name }),
    suggestActions: () => generateActionSuggestions({ force: true }),
    inspectRegion: async ({ regionId, name } = {}) => {
      const world = await readWorldState({ force: true });
      let id = regionId;
      let displayName = name || "";
      if (!id && name) {
        const cat = await loadRegionCatalog();
        const hit = cat.find((r) => r.name?.toLowerCase() === String(name).toLowerCase());
        id = hit?.id || "";
        displayName = hit?.name || displayName;
      } else if (id && !displayName) {
        const cat = await loadRegionCatalog();
        displayName = cat.find((r) => String(r.id) === String(id))?.name || "";
      }
      const owner = id ? world.regionOwnershipOverrides?.[id] ?? "" : "";
      const feats = queryRegionFeatures(map, id);
      return {
        regionId: id || "",
        name: displayName,
        owner,
        loadedOnMap: feats.length > 0,
        properties: feats[0]?.properties ?? null,
      };
    },

    // --- history / snapshots --------------------------------------------------
    snapshots: () => loadRollbackSnapshots(),
    undo: (index = 0) => _serialize("undo", () => rollBackToSnapshot(index)),

    // --- map capture ----------------------------------------------------------
    // Center on a named target, wait for the map to settle, and read back the
    // WebGL canvas as a PNG data URL. Needs preserveDrawingBuffer:true (set in
    // World via GameApp's bot prop) or the canvas reads back blank. Prefers a
    // crisp fitBounds when the region's geometry is in loaded tiles; otherwise
    // geocodes the place name and flyTo's it.
    captureMap: async ({ region, country, zoom = 4, center, world } = {}) => {
      await mapReadyPromise;
      const target = region || country || "";
      // Fit all inhabited latitudes so every country shows (trims Antarctica and
      // the empty polar caps). Used for world:true and as the no-target default.
      // The game caps minZoom at 2.25 for play; at that cap only ~half the globe
      // fits, so drop the floor first (bot map is capture-only) and let fitBounds
      // zoom out enough for the whole world.
      const fitWorld = () => {
        if (map.getMinZoom() > 1) map.setMinZoom(1);
        map.fitBounds([[-179, -56], [179, 78]], { padding: 2, duration: 0 });
      };
      let framed = false;
      if (world) {
        fitWorld();
        framed = true;
      } else if (region) {
        try {
          const cat = await loadRegionCatalog();
          const hit = cat.find((r) => r.name?.toLowerCase() === String(region).toLowerCase());
          const feats = hit?.id ? queryRegionFeatures(map, hit.id) : [];
          const box = feats.length ? bboxOfFeatures(feats) : null;
          if (box) {
            map.fitBounds(box, { padding: 40, duration: 0 });
            framed = true;
          }
        } catch {
          /* fall through to geocode */
        }
      }
      if (!framed) {
        let c = center;
        if (!c && target) {
          try {
            const [hit] = await geocodePlace(target, 1);
            if (hit) c = [Number(hit.lon), Number(hit.lat)];
          } catch {
            /* no geocode — fall back to the world view below */
          }
        }
        if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          map.flyTo({ center: c, zoom, duration: 0, essential: true });
        } else {
          fitWorld(); // no usable target -> show the whole world, not wherever the camera sat
        }
      }
      // Settle ROBUSTLY. 'idle' can fire before the new view actually paints —
      // the basemap tiles for a fresh zoom/position are still loading (or ESRI
      // errored them) — which returned a blank/transparent PNG. Wait for idle,
      // confirm the canvas has real content, and retry a few times; then ALWAYS
      // composite the frame over an opaque ocean so a missing/partial basemap can
      // never yield a fully transparent image.
      const hasContent = () => {
        try {
          const cvs = map.getCanvas();
          const s = document.createElement("canvas");
          s.width = 24;
          s.height = 24;
          const ctx = s.getContext("2d");
          ctx.clearRect(0, 0, 24, 24);
          ctx.drawImage(cvs, 0, 0, 24, 24);
          const d = ctx.getImageData(0, 0, 24, 24).data;
          let opaque = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 10) opaque += 1;
          return opaque > 24 * 24 * 0.2; // >20% opaque = the frame painted
        } catch {
          return true; // can't check — assume it's fine
        }
      };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await waitForIdle(map, 4000);
        if (attempt === 4 || hasContent()) break;
        await new Promise((r) => {
          map.triggerRepaint?.();
          setTimeout(r, 400);
        });
      }
      const src = map.getCanvas();
      const out = document.createElement("canvas");
      out.width = src.width;
      out.height = src.height;
      const octx = out.getContext("2d");
      octx.fillStyle = "#0b1a2b"; // opaque ocean/space, so the PNG is never transparent
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(src, 0, 0);
      return out.toDataURL("image/png");
    },
  };

  window.oh = oh;
  window.dispatchEvent(new CustomEvent("oh:ready"));
}

export default function BotHost() {
  const mapRef = useRef(null);
  const readyRef = useRef(null);
  if (!readyRef.current) {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    readyRef.current = { promise, resolve, installed: false };
  }

  const onFirstWorldIdle = useCallback((ref) => {
    const raw = ref?.current?.getMap?.();
    if (!raw || readyRef.current.installed) return;
    readyRef.current.installed = true;
    installOhSurface(raw, readyRef.current.promise);
    window.oh._map = raw;
    readyRef.current.resolve(raw);
  }, []);

  useEffect(
    () => () => {
      // Leaving bot mode: drop the global so a later mount reinstalls cleanly.
      if (window.oh?._installed) {
        try {
          delete window.oh;
        } catch {
          window.oh = undefined;
        }
      }
    },
    [],
  );

  return <GameApp bot externalMapRef={mapRef} onFirstWorldIdle={onFirstWorldIdle} />;
}
