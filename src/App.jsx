/*! Open Historia — portions (standalone map-editor mode) © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Map from "./Game/Map/World.jsx";
import UI from "./Game/GameUI/main.jsx";

// Lazy so OpenLayers is only fetched when the editor is actually opened.
const MapEditor = lazy(() => import("./Editor/MapEditor.jsx"));
// Lazy so the headless-bot bridge code (window.oh + map capture) is only fetched
// when the game is opened in ?bot=1 mode — the normal game never loads it.
const BotHost = lazy(() => import("./runtime/BotHost.jsx"));
import StartupScreen from "./runtime/StartupScreen.jsx";
import {
  STARTUP_TIME_BUDGET_MS,
  createInitialStartupState,
  runStartupPreload,
} from "./runtime/preload.js";
import { ensureLibraryCatalog, useLibraryState } from "./runtime/library.js";
import { isSpectator } from "./runtime/spectator.js";
import { installRafPump } from "./runtime/rafPump.js";

const WorldShell = {
  backgroundColor: "#000",
  position: "fixed",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  touchAction: "none",
};

const Vignette = {
  position: "fixed",
  inset: 0,
  background: "radial-gradient(ellipse at center, transparent 70%, rgba(0,0,0,0.25) 100%)",
  pointerEvents: "none",
  zIndex: 10,
};

// All props optional with internal fallbacks, so <GameApp /> (the normal render
// path) behaves exactly as before. The headless bot host (?bot=1) passes bot to
// force a readable WebGL buffer, externalMapRef to own the map handle, and
// onFirstWorldIdle to learn when the live MapLibre map is ready to instrument.
function GameApp({ bot = false, externalMapRef = null, onFirstWorldIdle } = {}) {
  const internalMapRef = useRef(null);
  const mapRef = externalMapRef || internalMapRef;
  const preloadStartedAtRef = useRef(null);
  const preloadFinishedRef = useRef(false);
  const worldIdleRef = useRef(false);
  const [startupState, setStartupState] = useState(createInitialStartupState);
  const [isReady, setIsReady] = useState(false);
  const [hasFirstWorldIdle, setHasFirstWorldIdle] = useState(false);
  const [isGlobeEnabled, setIsGlobeEnabled] = useState(() => {
    const saved = localStorage.getItem("Globe");
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [isTerrainEnabled, setIsTerrainEnabled] = useState(() => {
    const saved = localStorage.getItem("Terrain");
    return saved !== null ? JSON.parse(saved) : true;
  });
  // Key the map/UI on the active GAME id, not the library token. The token also
  // bumps on scenario/asset writes, so Apply & Play (which saves the scenario and
  // uploads several assets before activating the new game) would otherwise remount
  // the map ~8 times — the repeated flashing/reloading. The game id changes once,
  // when the new game activates, so the map remounts exactly once.
  const { activeGameId } = useLibraryState();

  useEffect(() => {
    localStorage.setItem("Globe", JSON.stringify(isGlobeEnabled));
  }, [isGlobeEnabled]);

  useEffect(() => {
    localStorage.setItem("Terrain", JSON.stringify(isTerrainEnabled));
  }, [isTerrainEnabled]);

  useEffect(() => {
    preloadStartedAtRef.current = performance.now();
    let isActive = true;
    let frameId = 0;

    const frame = () => {
      if (!isActive) return;
      const elapsedMs = Math.min(
        STARTUP_TIME_BUDGET_MS,
        Math.round(performance.now() - preloadStartedAtRef.current),
      );

      setStartupState((current) => {
        if (!preloadStartedAtRef.current || current.elapsedMs === elapsedMs) {
          return current;
        }

        return {
          ...current,
          elapsedMs,
        };
      });

      if (elapsedMs >= STARTUP_TIME_BUDGET_MS) {
        setIsReady(true);
        return;
      }

      if (preloadFinishedRef.current && worldIdleRef.current) {
        setIsReady(true);
        return;
      }

      frameId = requestAnimationFrame(frame);
    };

    frameId = requestAnimationFrame(frame);

    setStartupState((current) => ({
      ...current,
      stage: "Syncing games and scenarios",
    }));

    ensureLibraryCatalog()
      .catch((error) => {
        console.warn("Failed to load library catalog before startup preload:", error);
      })
      .finally(() => {
        if (!isActive) return;

        runStartupPreload({
          onProgress: (nextState) => {
            if (!isActive) return;
            setStartupState((current) => ({ ...current, ...nextState }));
          },
        }).finally(() => {
          preloadFinishedRef.current = true;
          if (!isActive) return;

          if (worldIdleRef.current) {
            setIsReady(true);
          } else {
            setStartupState((current) => ({
              ...current,
              done: true,
            }));
          }
        });
      });

    return () => {
      isActive = false;
      cancelAnimationFrame(frameId);
    };
  }, []);

  const handleFirstWorldIdle = () => {
    if (worldIdleRef.current) return;
    worldIdleRef.current = true;
    setHasFirstWorldIdle(true);

    if (preloadFinishedRef.current) {
      setIsReady(true);
    }

    // Tell a bot host the live map handle is ready (no-op in the normal game).
    onFirstWorldIdle?.(mapRef);
  };

  const startupOverlayState = useMemo(() => {
    if (isReady || hasFirstWorldIdle || !startupState.done) {
      return startupState;
    }

    return {
      ...startupState,
      progress: Math.max(startupState.progress, 97),
      stage: "Finalizing first world render",
    };
  }, [hasFirstWorldIdle, isReady, startupState]);

  return (
    <>
    <div style={WorldShell}>
    <Map
    key={`map-${activeGameId || "default"}`}
    mapRef={mapRef}
    preserveDrawingBuffer={bot}
    projection={isGlobeEnabled ? "globe" : "mercator"}
    terrainEnabled={isTerrainEnabled}
    onInitialIdle={handleFirstWorldIdle}
    />
    <div style={Vignette} />
    </div>
    {isReady && (
      <UI
      key={`ui-${activeGameId || "default"}`}
      isGlobeEnabled={isGlobeEnabled}
      isTerrainEnabled={isTerrainEnabled}
      mapRef={mapRef}
      setIsGlobeEnabled={setIsGlobeEnabled}
      setIsTerrainEnabled={setIsTerrainEnabled}
      />
    )}
    {!isReady && <StartupScreen {...startupOverlayState} />}
    </>
  );
}

// Standalone modes are isolated behind URL flags so the real game is untouched:
//   ?bot=1        -> the headless bot host (Discord edition): renders the real
//                    game and installs the window.oh control surface the bridge drives
//   ?editor=1     -> the OpenLayers map editor (author custom maps)
//   ?spectator=1  -> read-only spectator (Discord live map): the SAME GameApp,
//                    but write controls self-hide via isSpectator(). Cosmetic
//                    only — the enforced boundary is the loopback bind + read-only
//                    proxy (see runtime/spectator.js).
// Flags are read once at render time, so hook order stays consistent.
function App() {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  if (params.has("bot")) {
    return (
      <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "#0b1020" }} />}>
        <BotHost />
      </Suspense>
    );
  }
  if (params.has("editor")) {
    return (
      <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "#0b1020" }} />}>
        <MapEditor />
      </Suspense>
    );
  }
  // Spectator is NOT a component swap — the viewer needs the full live map + UI.
  // Prime the flag and expose a CSS hook; every write control self-hides via
  // isSpectator() in the descendant HUD components. The render pump is inert in a
  // normal foreground tab (native rAF) and only engages if the view is hidden or
  // embedded — so a thumbnail/Activity render of the live map still paints.
  if (typeof document !== "undefined" && isSpectator()) {
    document.body.dataset.spectator = "1";
    installRafPump();
  }
  return <GameApp />;
}

export { GameApp };
export default App;
