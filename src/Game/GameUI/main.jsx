/*! Open Historia — portions (mobile HUD wiring + advisor/forces launchers) © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { SettingsButton, SettingsMenu } from "./settings";
import { LibraryTopBar, TOP_BAR_OFFSET } from "./libraryBar";
import { useLibraryState } from "../../runtime/library.js";
import { DateWidget } from "./time";
import { Other } from "./other";
import { Toolbar } from "./chat";
import { Search } from "./search";
import { ForcesPanel } from "./forces";
import { isSpectator } from "../../runtime/spectator.js";
import { readGameData } from "../../runtime/gameState.js";

// A minimal read-only "who / when" pill for Discord live-map spectators — the
// only chrome they get. Polls the shared game state so the date advances live as
// the bot resolves rounds, with no interactive controls.
function SpectatorPill() {
  const [info, setInfo] = useState({ country: "", date: "" });
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const g = await readGameData({ force: true });
        if (active) setInfo({ country: g.country || "", date: g.gameDate || "" });
      } catch {
        /* keep the last known values */
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);
  if (!info.date) return null;
  return (
    <div style={{
      position: "fixed", top: "0.6rem", left: "50%", transform: "translateX(-50%)", zIndex: 20,
      background: "rgba(10,14,25,0.72)", color: "rgba(255,255,255,0.92)", padding: "0.4rem 0.95rem",
      borderRadius: 999, fontSize: "0.82rem", fontWeight: 600, letterSpacing: "0.02em",
      pointerEvents: "none", backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,0.08)",
      whiteSpace: "nowrap", maxWidth: "90vw", overflow: "hidden", textOverflow: "ellipsis",
    }}>
      {info.country ? `${info.country} · ` : ""}{info.date}
    </div>
  );
}
import {
  getStoredProvider,
  loadProviderSettingsFormState,
  normalizeProvider,
  persistProviderSetting,
} from "../AI/providerConfig.js";

const ADVISOR_PANEL_WIDTH = "min(20rem, calc(100vw - 1rem))";
const baseStyle = {
  position: "fixed",
  backgroundColor: "rgba(17, 24, 39, 0.9)",
  backdropFilter: "blur(4px)",
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "white",
  fontFamily: "sans-serif",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.1)",
  boxShadow: "0 4px 6px -1px rgba(0,0,0,0.2)",
};
const LazyAdvisorPanel = lazy(() =>
  import("./advisor").then((module) => ({ default: module.AdvisorPanel })),
);
const LazyCheatsPanel = lazy(() =>
  import("./cheats").then((module) => ({ default: module.CheatsPanel })),
);

const checkWebGL = () => {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
};

const WebGLWarningPopup = () => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      backgroundColor: "rgba(0, 0, 0, 0.7)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 9999,
    }}
  >
    <div
      style={{
        backgroundColor: "#1a1a2e",
        border: "1px solid #e94560",
        borderRadius: "12px",
        padding: "2rem",
        maxWidth: "420px",
        width: "90%",
        color: "#eaeaea",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: "3rem",
          marginBottom: "0.75rem",
          color: "#e94560",
          display: "flex",
          justifyContent: "center",
        }}
      >
        ⚠️
      </div>
      <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.3rem", color: "#e94560" }}>
        WebGL Not Available
      </h2>
      <p style={{ margin: "0 0 0.5rem", lineHeight: 1.6, color: "#ccc", fontSize: "0.95rem" }}>
        This application requires <strong style={{ color: "#eaeaea" }}>WebGL</strong> to render
        the map, but it doesn't appear to be supported or enabled in your browser.
      </p>
      <p style={{ margin: "0 0 1.5rem", lineHeight: 1.6, color: "#999", fontSize: "0.85rem" }}>
        Try enabling hardware acceleration in your browser settings, updating your graphics
        drivers, or switching to a WebGL-supported browser such as Chrome or Firefox.
      </p>
    </div>
  </div>
);

const AdvisorButton = ({ isAdvisorOpen, rightShift, onToggle }) => (
  <button onClick={onToggle} style={{
    ...baseStyle,
    bottom: "0.5rem", right: rightShift,
    height: "4rem", width: "4rem",
    cursor: "pointer", fontSize: "1.5rem",
    transition: "right 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
  }}>🧭</button>
);

const Main = ({
  mapRef,
  isGlobeEnabled,
  isTerrainEnabled,
  setIsGlobeEnabled,
  setIsTerrainEnabled,
}) => {
  const spectator = isSpectator();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCheatsOpen, setIsCheatsOpen] = useState(false);
  const [shouldLoadCheats, setShouldLoadCheats] = useState(false);
  const [isAdvisorOpen, setIsAdvisorOpen] = useState(false);
  const [isForcesOpen, setIsForcesOpen] = useState(false);
  const [activeBottomPanel, setActiveBottomPanel] = useState(null);
  const [shouldLoadAdvisor, setShouldLoadAdvisor] = useState(false);
  const [isFullscreenEnabled, setIsFullscreenEnabled] = useState(false);
  const [showWebGLWarning, setShowWebGLWarning] = useState(false);

  const [apiProvider, setApiProvider] = useState(() => getStoredProvider());
  const [providerSettings, setProviderSettings] = useState(() => loadProviderSettingsFormState());
  const { games, loaded } = useLibraryState();
  // No games -> nothing to simulate (the main menu covers the empty world).
  const hasNoGames = loaded && (games?.length ?? 0) === 0;

  useEffect(() => {
    if (!checkWebGL()) setShowWebGLWarning(true);
  }, []);

  // Idle diplomacy drip: each real-world minute the game is open (and has a
  // running game), there is a small chance a polity messages the player's
  // inbox unprompted. Everything that could break it is guarded inside
  // maybeSendIdleDiplomacy — it skips entirely while a time skip, game-master
  // command, or catalyst stage is in flight, never overlaps itself, and stays
  // silent on any failure. Hidden tabs don't roll the dice.
  useEffect(() => {
    if (hasNoGames) return undefined;
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      import("../AI/gameplay.js")
        .then(({ maybeSendIdleDiplomacy }) => maybeSendIdleDiplomacy())
        .catch(() => {});
    }, 60000);
    return () => clearInterval(iv);
  }, [hasNoGames]);

  useEffect(() => {
    if (isAdvisorOpen) setShouldLoadAdvisor(true);
  }, [isAdvisorOpen]);

  useEffect(() => {
    localStorage.setItem("Fullscreen", JSON.stringify(isFullscreenEnabled));
  }, [isFullscreenEnabled]);

  useEffect(() => {
    localStorage.setItem("api_provider", normalizeProvider(apiProvider));
  }, [apiProvider]);

  useEffect(() => {
    if (isSettingsOpen) {
      setApiProvider(getStoredProvider());
      setProviderSettings(loadProviderSettingsFormState());
    }
  }, [isSettingsOpen]);

  const handleProviderSettingChange = (key, value) => {
    setProviderSettings((prev) => ({ ...prev, [key]: value }));
    persistProviderSetting(key, value);
  };

  const toggleFullscreen = (shouldBeFull) => {
    // Mobile Safari (iOS/iPad) exposes the Fullscreen API webkit-prefixed, and
    // iPhone Safari doesn't support element fullscreen at all — so probe for the
    // right methods and never call an undefined one (which threw before, so the
    // button silently failed on mobile).
    const el = document.documentElement;
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      if (shouldBeFull) {
        if (!fsElement && request) {
          const result = request.call(el);
          if (result && typeof result.catch === "function") {
            result.catch((error) => console.error("Error with fullscreen", error));
          }
        }
      } else if (fsElement && exit) {
        exit.call(document);
      }
    } catch (error) {
      console.error("Error with fullscreen", error);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () =>
      setIsFullscreenEnabled(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  const openAdvisor = useCallback(() => {
    setIsAdvisorOpen(true);
  }, []);

  const rightShift = isAdvisorOpen ? `calc(${ADVISOR_PANEL_WIDTH} + 0.5rem)` : "0.5rem";
  const toggleBottomPanel = useCallback((panelName) => {
    setActiveBottomPanel((currentPanel) => (
      currentPanel === panelName ? null : panelName
    ));
  }, []);

  return (
    <>
      {showWebGLWarning && <WebGLWarningPopup />}
      {/* Discord live-map spectators get a bare view: just the map plus a
          read-only date/nation indicator. Everything interactive — the library/
          session top bar, the toolbar (chat/events/actions), the settings menu,
          and search — is hidden. */}
      {!spectator && <LibraryTopBar />}
      {spectator ? (
        <SpectatorPill />
      ) : (
        <DateWidget
          activePanel={activeBottomPanel}
          mapRef={mapRef}
          onSetPanel={setActiveBottomPanel}
          onTogglePanel={toggleBottomPanel}
          rightShift={rightShift}
          topOffset={TOP_BAR_OFFSET}
        />
      )}
      {!spectator && (
        <Toolbar
          onOpenAdvisor={openAdvisor}
          activePanel={activeBottomPanel}
          onTogglePanel={toggleBottomPanel}
        />
      )}
      {!spectator && <Other rightShift={rightShift} />}
      {!spectator && <Search mapRef={mapRef} />}
      {/* Forces (deploy), Advisor (game-master commands) and Cheats are all
          write-only affordances — hidden for read-only spectators. */}
      {!spectator && (
        <ForcesPanel
          mapRef={mapRef}
          topOffset={TOP_BAR_OFFSET}
          open={isForcesOpen}
          onToggle={() => setIsForcesOpen((v) => !v)}
        />
      )}
      {!spectator && (
        <AdvisorButton
          isAdvisorOpen={isAdvisorOpen}
          rightShift={rightShift}
          onToggle={() => setIsAdvisorOpen(!isAdvisorOpen)}
        />
      )}
      <Suspense fallback={null}>
        {!spectator && shouldLoadAdvisor && (
          <LazyAdvisorPanel isAdvisorOpen={isAdvisorOpen} onClose={() => setIsAdvisorOpen(false)} />
        )}
      </Suspense>
      <Suspense fallback={null}>
        {!spectator && shouldLoadCheats && (
          <LazyCheatsPanel open={isCheatsOpen} onClose={() => setIsCheatsOpen(false)} onOpenForces={() => { setIsCheatsOpen(false); setIsForcesOpen(true); }} />
        )}
      </Suspense>
      {!spectator && (
      <SettingsButton
        topOffset={TOP_BAR_OFFSET}
        onToggle={() => setIsSettingsOpen(!isSettingsOpen)}
      />
      )}
      {!spectator && isSettingsOpen && (
        <SettingsMenu
          discordUrl="https://discord.gg/C3AVwHacZ4"
          redditUrl="https://www.reddit.com/r/OpenHistoria"
          githubUrl="https://github.com/Open-Historia/open-historia"
          onOpenCheats={() => {
            setShouldLoadCheats(true);
            setIsCheatsOpen(true);
            setIsSettingsOpen(false);
          }}
          topOffset={TOP_BAR_OFFSET}
          isFullscreenEnabled={isFullscreenEnabled}
          isGlobeEnabled={isGlobeEnabled}
          isTerrainEnabled={isTerrainEnabled}
          onToggleFullscreen={() => {
            const newState = !isFullscreenEnabled;
            setIsFullscreenEnabled(newState);
            toggleFullscreen(newState);
          }}
          onToggleGlobe={() => setIsGlobeEnabled(!isGlobeEnabled)}
          onToggleTerrain={() => setIsTerrainEnabled(!isTerrainEnabled)}
          apiProvider={apiProvider}
          onApiProviderChange={setApiProvider}
          providerSettings={providerSettings}
          onProviderSettingChange={handleProviderSettingChange}
        />
      )}
    </>
  );
};

export default Main;
