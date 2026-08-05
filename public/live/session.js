// Arrancar/parar una sesión (con o sin remadora conectada), guardado con reintentos,
// y respaldo en localStorage para no perder una sesión si se cierra la pestaña o se cae el wifi.

import { $, state, fmtTime, fmtPace, describeError, setLiveScreen, goToTopScreen } from "./state.js";
import { buildProgramChart, updateProgramChartActive, segmentAtElapsed, programTotalDuration } from "./programChart.js";
import { startMetronome, stopMetronome } from "./metronome.js";
import { showCelebrationIfAny } from "./goalsRecords.js";
import { liveApi } from "./api.js";
import { computeStats, drawSparkline } from "./sparkline.js";

const PENDING_SESSION_KEY = "remo2_pending_session";

function savePendingSessionSnapshot() {
  if (!state.sessionStart) return;
  try {
    localStorage.setItem(
      PENDING_SESSION_KEY,
      JSON.stringify({
        sessionStart: state.sessionStart,
        freeMode: state.freeMode,
        metroBpm: state.metroBpm,
        metroEnabled: state.metroEnabled,
        activeProgram: state.activeProgram,
        programSegmentIndex: state.programSegmentIndex,
        samples: state.samples,
        latest: state.latest,
      }),
    );
  } catch {
    // localStorage lleno o no disponible (modo privado, etc.): no es crítico, seguimos sin respaldo.
  }
}

export function clearPendingSessionSnapshot() {
  try {
    localStorage.removeItem(PENDING_SESSION_KEY);
  } catch {
    // ignorar
  }
}

export function readPendingSessionSnapshot() {
  try {
    const raw = localStorage.getItem(PENDING_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Reconstruye el estado de una sesión que quedó a medias (se cerró la pestaña, se durmió el
// celular, etc.) y la manda directo al resumen, como si el usuario acabara de darle "Finalizar".
export function resumePendingSession(snapshot) {
  state.sessionStart = snapshot.sessionStart;
  state.freeMode = snapshot.freeMode;
  state.metroBpm = snapshot.metroBpm;
  state.metroEnabled = snapshot.metroEnabled;
  state.activeProgram = snapshot.activeProgram || null;
  state.programSegmentIndex = snapshot.programSegmentIndex ?? -1;
  state.samples = snapshot.samples || [];
  state.latest = snapshot.latest || { distance: 0, pace: null, spm: 0, power: 0, cal: 0, hr: null, strokes: 0, elapsed: 0 };
  goToTopScreen("live");
  finishSession();
}

export function recordSample() {
  const t = (Date.now() - state.sessionStart) / 1000;
  state.samples.push({
    t: Math.round(t),
    elapsed: state.latest.elapsed,
    distance_m: state.latest.distance,
    pace_sec500m: state.latest.pace,
    spm: state.latest.spm,
    power_w: state.latest.power,
    cal: state.latest.cal,
    hr: state.latest.hr,
    strokes: state.latest.strokes,
  });
}

export function updateDashboard() {
  const elapsedLocal = state.sessionStart ? (Date.now() - state.sessionStart) / 1000 : 0;
  $("liveMTime").textContent = fmtTime(state.latest.elapsed || elapsedLocal);
  $("liveMDistance").textContent = (state.latest.distance / 1000).toFixed(2);
  $("liveMPace").textContent = fmtPace(state.latest.pace);
  $("liveMSpm").textContent = Math.round(state.latest.spm);
  $("liveMPower").textContent = Math.round(state.latest.power);
  $("liveMCal").textContent = Math.round(state.latest.cal);
  $("liveMHr").textContent = state.latest.hr != null ? state.latest.hr : "--";
  $("liveMStrokes").textContent = state.latest.strokes;
}

export function startSession(program) {
  state.sessionStart = Date.now();
  state.samples = [];
  state.latest = { distance: 0, pace: null, spm: 0, power: 0, cal: 0, hr: null, strokes: 0, elapsed: 0 };
  state.activeProgram = program || null;
  state.programSegmentIndex = -1;
  state.freeMode = !state.device;

  $("liveBleMetrics").style.display = state.freeMode ? "none" : "";
  $("liveFreeModeNote").style.display = state.freeMode ? "block" : "none";
  $("liveProgramBanner").style.display = program ? "block" : "none";
  if (program) buildProgramChart(program, $("liveProgramChart"));
  $("liveMetroLive").textContent = `${state.metroBpm} SPM`;
  $("liveBtnMetroToggle").textContent = "Pausar";

  setLiveScreen("Workout");
  updateDashboard();
  document.querySelector(".app-frame").classList.add("nav-compact");

  if (program) updateProgramProgress();
  else if (state.metroEnabled) startMetronome(state.metroBpm);

  savePendingSessionSnapshot();
  state.sessionTimer = setInterval(tick, 1000);
  // Mantiene la conexión a MySQL "despierta" durante la remada para que al terminar
  // el guardado sea instantáneo en vez de esperar a que la base de datos reaccione.
  pingDatabase();
  state.keepAliveTimer = setInterval(pingDatabase, 4 * 60 * 1000);
}

function tick() {
  updateDashboard();
  if (state.activeProgram) {
    updateProgramProgress();
  }
  savePendingSessionSnapshot();
}

function updateProgramProgress() {
  const program = state.activeProgram;
  const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
  const info = segmentAtElapsed(program, elapsed);

  if (!info) {
    $("liveProgramSegmentLabel").textContent = "¡Programa terminado!";
    $("liveProgramSegmentTime").textContent = "";
    $("liveProgramNextLabel").textContent = "";
    stopSession();
    return;
  }

  if (info.index !== state.programSegmentIndex) {
    state.programSegmentIndex = info.index;
    state.metroBpm = info.seg.targetSpm;
    $("liveMetroLive").textContent = `${state.metroBpm} SPM`;
    if (state.metroEnabled) startMetronome(info.seg.targetSpm);
    updateProgramChartActive(info.index);
  }

  $("liveProgramSegmentLabel").textContent = `Tramo ${info.index + 1}/${program.segments.length} · ${info.seg.targetSpm} SPM`;
  $("liveProgramSegmentTime").textContent = fmtTime(info.segRemaining);
  const next = program.segments[info.index + 1];
  $("liveProgramNextLabel").textContent = next ? `${next.targetSpm} SPM (${fmtTime(next.durationSec)})` : "Último tramo";

  updateTotalProgress(program, elapsed, info);
}

// Barra de avance de todo el entrenamiento, como la de una película: "llevas X / faltan Y".
// El % se mide con la posición real en pantalla del tramo activo (no solo con la cuenta de
// tiempo), porque la gráfica tiene espacios entre barras y un ancho mínimo por barra que no
// son exactamente proporcionales a la duración — usar solo tiempo la desfasaba visualmente.
function updateTotalProgress(program, elapsed, info) {
  const total = programTotalDuration(program);
  const clampedElapsed = Math.min(elapsed, total);
  const remaining = Math.max(0, total - clampedElapsed);

  let percent = total > 0 ? (clampedElapsed / total) * 100 : 0;
  const chartEl = $("liveProgramChart");
  const activeItem = info && chartEl ? chartEl.querySelectorAll(".chart-bar-item")[info.index] : null;
  if (activeItem) {
    const chartRect = chartEl.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    if (chartRect.width > 0) {
      const elapsedInSeg = info.seg.durationSec - info.segRemaining;
      const fracInSeg = info.seg.durationSec > 0 ? elapsedInSeg / info.seg.durationSec : 0;
      const pxPos = itemRect.left - chartRect.left + itemRect.width * fracInSeg;
      percent = (pxPos / chartRect.width) * 100;
    }
  }

  $("liveTotalFill").style.width = `${percent}%`;
  $("liveTotalRemaining").textContent = `-${fmtTime(remaining)}`;
}

export async function stopSession() {
  clearInterval(state.sessionTimer);
  clearInterval(state.keepAliveTimer);
  stopMetronome();
  document.querySelector(".app-frame").classList.remove("nav-compact");
  finishSession();
}

function finishSession() {
  const summary = buildSummary();
  renderSummary(summary);
  setLiveScreen("Summary");

  if (state.freeMode) {
    state.pendingFreeSummary = summary;
    ["liveFreeKm", "liveFreeStrokes", "liveFreeCal", "liveFreeSpm", "liveFreeHr"].forEach((id) => {
      $(id).value = "";
    });
    $("liveFreeMetricsForm").style.display = "block";
    $("liveSaveStatus").innerHTML = "";
  } else {
    $("liveFreeMetricsForm").style.display = "none";
    saveSessionWithRetry(() => saveSessionToServer(summary));
  }
}

// ---------- Guardado con reintentos (la conexión a MySQL se "enfría" tras inactividad) ----------
async function isDatabaseReady() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    return !!data.databaseReady;
  } catch {
    return false;
  }
}

function pingDatabase() {
  fetch("/api/auth/me").catch(() => {});
}

async function waitForDatabaseReady(onProgress, maxAttempts = 20, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    pingDatabase();
    // eslint-disable-next-line no-await-in-loop
    if (await isDatabaseReady()) return true;
    if (onProgress) onProgress(attempt, maxAttempts);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function setSaveStatus(kind, text, retryPoster) {
  const el = $("liveSaveStatus");
  if (!el) return;
  el.className = `live-save-status live-save-${kind}`;
  el.innerHTML = text;
  if (kind === "error" && retryPoster) {
    const btn = document.createElement("button");
    btn.className = "mini-button";
    btn.textContent = "Reintentar";
    btn.addEventListener("click", () => saveSessionWithRetry(retryPoster));
    el.appendChild(document.createTextNode(" "));
    el.appendChild(btn);
  }
}

// poster: función async sin argumentos que hace el POST y regresa la sesión guardada.
async function saveSessionWithRetry(poster) {
  setSaveStatus("saving", "Guardando sesión...");

  const ready = await waitForDatabaseReady((attempt, max) => {
    setSaveStatus("saving", `Despertando la base de datos... (intento ${attempt}/${max})`);
  });

  if (!ready) {
    setSaveStatus("error", "La base de datos no respondió a tiempo.", poster);
    return;
  }

  const maxSaveAttempts = 3;
  for (let attempt = 1; attempt <= maxSaveAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const saved = await poster();
      setSaveStatus("success", "Sesión guardada en tu historial ✓");
      clearPendingSessionSnapshot();
      showCelebrationIfAny(saved.brokenRecords, saved.goalsCompleted);
      return;
    } catch (err) {
      if (attempt === maxSaveAttempts) {
        console.error(err);
        setSaveStatus("error", "No se pudo guardar: " + describeError(err), poster);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
}

function average(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function buildSummary() {
  const durationSec = state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 1000) : 0;
  const paces = state.samples.map((s) => s.pace_sec500m).filter((p) => p != null && p > 0);
  const spms = state.samples.map((s) => s.spm).filter((v) => v > 0);
  const powers = state.samples.map((s) => s.power_w).filter((v) => v > 0);
  const hrs = state.samples.map((s) => s.hr).filter((v) => v != null && v > 0);

  return {
    date: new Date().toISOString(),
    durationSec,
    distanceM: state.latest.distance,
    calories: state.latest.cal,
    avgPaceSec500m: paces.length ? average(paces) : null,
    avgSpm: average(spms),
    avgPower: average(powers),
    avgHeartRate: hrs.length ? average(hrs) : null,
    strokes: state.latest.strokes,
    metroBpm: state.metroEnabled ? state.metroBpm : null,
    programName: state.activeProgram ? state.activeProgram.name : null,
    samples: state.samples,
  };
}

async function saveSessionToServer(s) {
  return liveApi("/api/live-sessions", {
    method: "POST",
    body: {
      sessionDate: s.date.slice(0, 10),
      kilometers: s.distanceM / 1000,
      strokes: s.strokes,
      calories: s.calories,
      durationSeconds: s.durationSec,
      avgSpm: s.avgSpm || null,
      avgPowerW: s.avgPower || null,
      avgPaceSec500m: s.avgPaceSec500m,
      avgHeartRate: s.avgHeartRate,
      programName: s.programName,
      metronomeBpm: s.metroBpm,
      samples: s.samples,
      source: "live",
    },
  });
}

export function saveFreeSession() {
  const summary = state.pendingFreeSummary;
  if (!summary) return;

  const optionalNumber = (id) => {
    const raw = $(id).value;
    return raw === "" ? null : Number(raw);
  };

  const body = {
    sessionDate: summary.date.slice(0, 10),
    kilometers: optionalNumber("liveFreeKm") || 0,
    strokes: optionalNumber("liveFreeStrokes") || 0,
    calories: optionalNumber("liveFreeCal") || 0,
    durationSeconds: summary.durationSec,
    avgSpm: optionalNumber("liveFreeSpm"),
    avgHeartRate: optionalNumber("liveFreeHr"),
    programName: summary.programName,
    metronomeBpm: summary.metroBpm,
    samples: [],
    source: "free",
  };

  $("liveFreeMetricsForm").style.display = "none";
  saveSessionWithRetry(() => liveApi("/api/live-sessions", { method: "POST", body }));
}

// Arma el bloque de "gráfica continua + prom/máx/mín" para una métrica dada (SPM,
// potencia, pulso). Si no hay al menos 2 muestras válidas, solo se ve el texto "--".
function metricSparkBlock(id, label, sampleKey, samples, unit) {
  const series = samples.map((sample) => ({ t: sample.t, v: sample[sampleKey] }));
  const stats = computeStats(series.map((p) => p.v));
  const valueText = stats.count
    ? `${Math.round(stats.avg)} / ${Math.round(stats.max)} / ${Math.round(stats.min)}`
    : "--";
  const canvasHtml = stats.count > 1 ? `<canvas id="${id}" class="summary-spark"></canvas>` : "";
  return {
    html: `${canvasHtml}<div class="live-summary-row"><span>${label} (prom / máx / mín)</span><strong>${valueText}</strong></div>`,
    draw: stats.count > 1 ? () => drawSparkline($(id), series, { unit, decimals: 0 }) : null,
  };
}

function renderSummary(s) {
  const blocks = [];
  const draws = [];
  const row = (k, v) => blocks.push(`<div class="live-summary-row"><span>${k}</span><strong>${v}</strong></div>`);

  if (s.programName) row("Programa", s.programName);
  row("Duración", fmtTime(s.durationSec));

  if (state.freeMode) {
    row("Metrónomo", s.metroBpm ? `${s.metroBpm} SPM` : "Desactivado");
  } else {
    const samples = s.samples || [];
    row("Distancia", `${(s.distanceM / 1000).toFixed(2)} km`);
    row("Ritmo promedio", `${fmtPace(s.avgPaceSec500m)} /500m`);

    [
      ["liveSummarySparkSpm", "SPM", "spm", "spm"],
      ["liveSummarySparkPower", "Potencia", "power_w", "W"],
      ["liveSummarySparkHr", "Pulso", "hr", "bpm"],
    ].forEach(([id, label, key, unit]) => {
      const block = metricSparkBlock(id, label, key, samples, unit);
      blocks.push(block.html);
      if (block.draw) draws.push(block.draw);
    });

    row("Calorías", Math.round(s.calories));
    row("Remadas totales", s.strokes);
    row("Metrónomo", s.metroBpm ? `${s.metroBpm} SPM` : "Desactivado");
  }

  $("liveSummaryBox").innerHTML = blocks.join("");
  draws.forEach((draw) => draw());
  state.lastSummary = s;
}
