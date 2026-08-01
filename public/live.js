// Remo en vivo — punto de entrada. Conecta los botones del DOM con la lógica que vive en
// ./live/*.js (Bluetooth, metrónomo, sesión, programas, metas/récords, compartir). La lógica
// en sí está separada por tema para que sea más fácil de mantener; este archivo solo cablea.

import { $, state, describeError, goToTopScreen, setLiveScreen } from "./live/state.js";
import { liveApi } from "./live/api.js";
import { connect, connectHR } from "./live/ble.js";
import { startMetronome, stopMetronome, adjustMetroBpm } from "./live/metronome.js";
import {
  startSession,
  stopSession,
  saveFreeSession,
  resumePendingSession,
  readPendingSessionSnapshot,
  clearPendingSessionSnapshot,
} from "./live/session.js";
import {
  renderProgramsList,
  openProgramEditor,
  addSegment,
  addBlockSegment,
  addBlockToProgram,
  saveProgramFromEditor,
} from "./live/programs.js";
import { renderGoalsList, renderRecordsGrid, hideCelebration } from "./live/goalsRecords.js";
import { shareSummary } from "./live/share.js";

// ---------- Recuperar sesión sin guardar (se cerró la pestaña, se durmió el celular, se cayó el wifi) ----------
function offerSessionRecovery() {
  const snapshot = readPendingSessionSnapshot();
  if (!snapshot || !snapshot.sessionStart) return;

  const minutesAgo = Math.max(0, Math.round((Date.now() - snapshot.sessionStart) / 60000));
  const label = snapshot.activeProgram ? snapshot.activeProgram.name : "remo libre";
  $("recoveryMessage").textContent =
    `Tenías una sesión de "${label}" sin guardar, de hace ${minutesAgo} min. ¿La recuperas para guardarla, o la descartas?`;
  $("recoveryOverlay").classList.remove("is-hidden");

  $("recoveryResumeButton").onclick = () => {
    $("recoveryOverlay").classList.add("is-hidden");
    resumePendingSession(snapshot);
  };
  $("recoveryDiscardButton").onclick = () => {
    clearPendingSessionSnapshot();
    $("recoveryOverlay").classList.add("is-hidden");
  };
}

// El recovery-prompt espera a que termine el login (appShell deja de tener "is-hidden")
// para no aparecer encima de la pantalla de entrar.
function whenAppShellVisible(callback) {
  const appShell = $("appShell");
  if (!appShell.classList.contains("is-hidden")) {
    callback();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!appShell.classList.contains("is-hidden")) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(appShell, { attributes: true, attributeFilter: ["class"] });
}

whenAppShellVisible(offerSessionRecovery);

// ---------- Eventos ----------
if (!navigator.bluetooth) {
  $("liveBtnConnect").textContent = "Bluetooth no disponible en este navegador";
  $("liveBtnConnect").disabled = true;
  $("liveBtnConnectHr").textContent = "Bluetooth no disponible en este navegador";
  $("liveBtnConnectHr").disabled = true;
}

$("liveBtnConnect").addEventListener("click", connect);
$("liveBtnConnectHr").addEventListener("click", connectHR);

document.querySelectorAll(".live-btn-step").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $("liveMetroBpm");
    const step = parseInt(btn.dataset.step, 10);
    input.value = Math.min(40, Math.max(10, parseInt(input.value, 10) + step));
  });
});

$("liveMetroEnabled").addEventListener("change", (e) => { state.metroEnabled = e.target.checked; });

$("liveBtnStart").addEventListener("click", () => {
  state.metroBpm = parseInt($("liveMetroBpm").value, 10) || 22;
  state.metroEnabled = $("liveMetroEnabled").checked;
  startSession();
});

$("liveBtnStop").addEventListener("click", stopSession);
$("liveBtnSaveFree").addEventListener("click", saveFreeSession);

$("liveMetroDown").addEventListener("click", () => adjustMetroBpm(-1));
$("liveMetroUp").addEventListener("click", () => adjustMetroBpm(1));

$("liveBtnMetroToggle").addEventListener("click", () => {
  if (state.metroRunning) {
    stopMetronome();
    $("liveBtnMetroToggle").textContent = "Reanudar";
  } else {
    startMetronome(state.metroBpm);
    $("liveBtnMetroToggle").textContent = "Pausar";
  }
});

$("liveBtnShare").addEventListener("click", () => shareSummary(state.lastSummary));
$("liveBtnBackHome").addEventListener("click", () => setLiveScreen("Setup"));

document.querySelectorAll('[data-goto-screen="programs"]').forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    renderProgramsList();
    setLiveScreen("Programs");
    goToTopScreen("programs");
  });
});
document.querySelector('.nav-button[data-screen="programs"]').addEventListener("click", () => {
  setLiveScreen("Programs");
  renderProgramsList();
});
$("liveBtnNewProgram").addEventListener("click", () => openProgramEditor(null));
$("liveBtnAddSegment").addEventListener("click", addSegment);
$("liveBtnAddBlockSegment").addEventListener("click", addBlockSegment);
$("liveBtnAddBlockToProgram").addEventListener("click", addBlockToProgram);
$("liveBtnSaveProgram").addEventListener("click", saveProgramFromEditor);
$("liveBtnCancelProgram").addEventListener("click", () => setLiveScreen("Programs"));

$("celebrateClose").addEventListener("click", hideCelebration);

$("goalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("goalName").value.trim();
  const metric = $("goalMetric").value;
  const targetValue = Number($("goalTarget").value);
  if (!name) return;
  try {
    await liveApi("/api/goals", { method: "POST", body: { name, metric, targetValue } });
    $("goalName").value = "";
    $("goalTarget").value = "";
    $("goalMessage").textContent = "";
    renderGoalsList();
  } catch (err) {
    $("goalMessage").textContent = describeError(err);
  }
});

document.querySelector('.nav-button[data-screen="goals"]').addEventListener("click", () => {
  renderGoalsList();
  renderRecordsGrid();
});
