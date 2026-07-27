// Remo en vivo — dashboard BLE FTMS (Merach R50 y cualquier remadora FTMS) + banda de FC.
// Al finalizar, la sesión se manda a /api/live-sessions y aparece en el Historial de Remo2.

const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const ROWER_DATA_CHAR = "00002ad1-0000-1000-8000-00805f9b34fb";
const HEART_RATE_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
const HEART_RATE_CHAR = "00002a37-0000-1000-8000-00805f9b34fb";

const $ = (id) => document.getElementById(id);

const state = {
  device: null,
  server: null,
  hrDevice: null,
  hrServer: null,
  hrConnected: false,
  metroTimer: null,
  metroAudioCtx: null,
  metroBpm: 22,
  metroEnabled: true,
  metroRunning: false,
  sessionStart: null,
  sessionTimer: null,
  samples: [],
  latest: { distance: 0, pace: null, spm: 0, power: 0, cal: 0, hr: null, strokes: 0, elapsed: 0 },
  editorSegments: [],
  editingProgramId: null,
  activeProgram: null,
  programSegmentIndex: -1,
  lastSummary: null,
};

// ---------- helpers ----------
function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function fmtPace(secPer500m) {
  if (secPer500m == null || !isFinite(secPer500m) || secPer500m <= 0) return "--:--";
  return fmtTime(secPer500m);
}

function goToTopScreen(name) {
  const navBtn = document.querySelector(`.nav-button[data-screen="${name}"]`);
  if (navBtn) navBtn.click(); // reutiliza showScreen() de app.js
}

function setLiveScreen(name) {
  // Solo togglea los paneles dentro de la MISMA pestaña principal (Remo en vivo vs Programas),
  // así cambiar de pestaña para ver programas no pierde el progreso de una sesión en curso.
  const target = $(`liveScreen${name}`);
  const scope = target.closest(".screen") || document;
  scope.querySelectorAll(".live-screen").forEach((el) => el.classList.remove("live-screen-active"));
  target.classList.add("live-screen-active");
}

// ---------- FTMS parsing ----------
function parseRowerData(dataView) {
  let offset = 0;
  const flags = dataView.getUint16(offset, true);
  offset += 2;
  const out = {};

  if ((flags & 0x0001) === 0) {
    out.strokeRate = dataView.getUint8(offset) * 0.5;
    offset += 1;
    out.strokeCount = dataView.getUint16(offset, true);
    offset += 2;
  }
  if (flags & 0x0002) { out.avgStrokeRate = dataView.getUint8(offset) * 0.5; offset += 1; }
  if (flags & 0x0004) {
    const b0 = dataView.getUint8(offset), b1 = dataView.getUint8(offset + 1), b2 = dataView.getUint8(offset + 2);
    out.totalDistance = b0 | (b1 << 8) | (b2 << 16);
    offset += 3;
  }
  if (flags & 0x0008) { out.instPace = dataView.getUint16(offset, true); offset += 2; }
  if (flags & 0x0010) { out.avgPace = dataView.getUint16(offset, true); offset += 2; }
  if (flags & 0x0020) { out.instPower = dataView.getInt16(offset, true); offset += 2; }
  if (flags & 0x0040) { out.avgPower = dataView.getInt16(offset, true); offset += 2; }
  if (flags & 0x0080) { out.resistanceLevel = dataView.getInt16(offset, true); offset += 2; }
  if (flags & 0x0100) {
    out.totalEnergy = dataView.getUint16(offset, true); offset += 2;
    out.energyPerHour = dataView.getUint16(offset, true); offset += 2;
    out.energyPerMinute = dataView.getUint8(offset); offset += 1;
  }
  if (flags & 0x0200) { out.heartRate = dataView.getUint8(offset); offset += 1; }
  if (flags & 0x0400) { out.metEquivalent = dataView.getUint8(offset) * 0.1; offset += 1; }
  if (flags & 0x0800) { out.elapsedTime = dataView.getUint16(offset, true); offset += 2; }
  if (flags & 0x1000) { out.remainingTime = dataView.getUint16(offset, true); offset += 2; }

  return out;
}

function onRowerData(event) {
  const parsed = parseRowerData(event.target.value);
  if (parsed.strokeRate != null) state.latest.spm = parsed.strokeRate;
  if (parsed.strokeCount != null) state.latest.strokes = parsed.strokeCount;
  if (parsed.totalDistance != null) state.latest.distance = parsed.totalDistance;
  if (parsed.instPace != null) state.latest.pace = parsed.instPace;
  if (parsed.instPower != null) state.latest.power = parsed.instPower;
  if (parsed.totalEnergy != null) state.latest.cal = parsed.totalEnergy;
  if (parsed.heartRate != null && !state.hrConnected) state.latest.hr = parsed.heartRate;
  if (parsed.elapsedTime != null) state.latest.elapsed = parsed.elapsedTime;
  updateDashboard();
  recordSample();
}

// ---------- Bluetooth ----------
function describeError(err) {
  if (err == null) return "sin detalle (el navegador no dio información del error)";
  if (err.name === "NotFoundError") return "no se eligió ningún dispositivo, o no se encontró ninguno cercano";
  if (err.name === "SecurityError") return "Bluetooth bloqueado en este contexto (¿https y dentro de Bluefy?)";
  let base;
  if (err.message) base = err.message;
  else if (err.name) base = err.name;
  else { try { base = JSON.stringify(err); } catch { base = String(err); } }
  if (/^error\s*\d*$/i.test(base.trim())) {
    base += " — el filtro por servicio Bluetooth a veces falla en Bluefy; intenta de nuevo";
  }
  return base;
}

function setConnState(connected) {
  const pill = $("liveConnState");
  pill.textContent = connected ? "Conectado" : "Desconectado";
  pill.className = connected ? "live-pill live-pill-on" : "live-pill live-pill-off";
}

async function connect() {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FTMS_SERVICE],
    });
  } catch (err) {
    console.error(err);
    alert("No se pudo abrir la lista de dispositivos: " + describeError(err));
    return;
  }

  try {
    state.device = device;
    $("liveDeviceName").textContent = `Vinculado: ${state.device.name || "remadora"}`;
    state.device.addEventListener("gattserverdisconnected", () => setConnState(false));

    state.server = await state.device.gatt.connect();
    const service = await state.server.getPrimaryService(FTMS_SERVICE);
    const char = await service.getCharacteristic(ROWER_DATA_CHAR);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", onRowerData);

    setConnState(true);
    $("liveBtnStart").disabled = false;
  } catch (err) {
    console.error(err);
    alert(`"${device.name || "ese dispositivo"}" no tiene el servicio de remadora (FTMS). Detalle: ` + describeError(err));
  }
}

function parseHeartRate(dataView) {
  const flags = dataView.getUint8(0);
  const is16bit = (flags & 0x01) !== 0;
  return is16bit ? dataView.getUint16(1, true) : dataView.getUint8(1);
}
function onHeartRateData(event) {
  state.latest.hr = parseHeartRate(event.target.value);
  updateDashboard();
}

async function connectHR() {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }],
      optionalServices: [HEART_RATE_SERVICE],
    });
  } catch (err) {
    console.error(err);
    alert("No se pudo abrir la lista de dispositivos: " + describeError(err));
    return;
  }

  try {
    state.hrDevice = device;
    $("liveHrDeviceName").textContent = `Vinculado: ${state.hrDevice.name || "banda de FC"}`;
    state.hrDevice.addEventListener("gattserverdisconnected", () => { state.hrConnected = false; });

    state.hrServer = await state.hrDevice.gatt.connect();
    const service = await state.hrServer.getPrimaryService(HEART_RATE_SERVICE);
    const char = await service.getCharacteristic(HEART_RATE_CHAR);
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", onHeartRateData);

    state.hrConnected = true;
  } catch (err) {
    console.error(err);
    alert(`"${device.name || "ese dispositivo"}" no tiene el servicio de FC estándar. Detalle: ` + describeError(err));
  }
}

// ---------- Metrónomo + barra visual ----------
function ensureAudioCtx() {
  if (!state.metroAudioCtx) state.metroAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.metroAudioCtx;
}
function beep() {
  const ctx = ensureAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.13);
}
function startStrokeBar(bpm) {
  const el = $("liveStrokeFill");
  if (!el) return;
  el.style.animationDuration = `${60 / bpm}s`;
  el.classList.remove("animate");
  void el.offsetWidth;
  el.classList.add("animate");
}
function stopStrokeBar() {
  const el = $("liveStrokeFill");
  if (!el) return;
  el.classList.remove("animate");
  el.style.width = "0%";
}
function startMetronome(bpm) {
  stopMetronome();
  state.metroBpm = bpm;
  ensureAudioCtx();
  beep();
  state.metroTimer = setInterval(beep, 60000 / bpm);
  state.metroRunning = true;
  startStrokeBar(bpm);
}
function stopMetronome() {
  if (state.metroTimer) clearInterval(state.metroTimer);
  state.metroTimer = null;
  state.metroRunning = false;
  stopStrokeBar();
}
function restartMetronomeIfRunning() {
  if (state.metroRunning) startMetronome(state.metroBpm);
}

// ---------- Sesión ----------
function recordSample() {
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

function updateDashboard() {
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

function startSession(program) {
  state.sessionStart = Date.now();
  state.samples = [];
  state.latest = { distance: 0, pace: null, spm: 0, power: 0, cal: 0, hr: null, strokes: 0, elapsed: 0 };
  state.activeProgram = program || null;
  state.programSegmentIndex = -1;

  $("liveProgramBanner").style.display = program ? "block" : "none";
  if (program) buildProgramChart(program);
  $("liveMetroLive").textContent = `${state.metroBpm} SPM`;
  $("liveBtnMetroToggle").textContent = "Pausar";

  setLiveScreen("Workout");
  updateDashboard();

  if (program) updateProgramProgress();
  else if (state.metroEnabled) startMetronome(state.metroBpm);

  state.sessionTimer = setInterval(tick, 1000);
}

function tick() {
  updateDashboard();
  if (state.activeProgram) updateProgramProgress();
}

function programTotalDuration(program) {
  return program.segments.reduce((a, s) => a + s.durationSec, 0);
}
function segmentAtElapsed(program, elapsedSec) {
  let acc = 0;
  for (let i = 0; i < program.segments.length; i++) {
    const seg = program.segments[i];
    if (elapsedSec < acc + seg.durationSec) return { index: i, seg, segRemaining: acc + seg.durationSec - elapsedSec };
    acc += seg.durationSec;
  }
  return null;
}
// Escala de color por intensidad relativa dentro del propio programa (azul=suave -> rojo=al tope)
function zoneColor(t) {
  const stops = [
    [0.0, [59, 130, 246]],
    [0.25, [34, 197, 94]],
    [0.5, [217, 180, 40]],
    [0.75, [234, 122, 30]],
    [1.0, [220, 60, 50]],
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      const mix = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
      return mix;
    }
  }
  return stops[stops.length - 1][1];
}

function buildProgramChart(program) {
  const el = $("liveProgramChart");
  const spms = program.segments.map((s) => s.targetSpm);
  const minSpm = Math.min(...spms);
  const maxSpm = Math.max(...spms);

  el.innerHTML = program.segments
    .map((seg, i) => {
      const t = maxSpm > minSpm ? (seg.targetSpm - minSpm) / (maxSpm - minSpm) : 0.5;
      const heightPct = Math.round(30 + t * 70);
      const [r, g, b] = zoneColor(t);
      return `<div class="chart-bar-item" data-index="${i}" style="flex-grow:${seg.durationSec}">
        <span class="chart-bar-label">${seg.targetSpm}</span>
        <div class="chart-bar" style="height:${heightPct}%; background: linear-gradient(180deg, rgba(${r},${g},${b},1), rgba(${r},${g},${b},0.55));"></div>
      </div>`;
    })
    .join("");
}

function updateProgramChartActive(index) {
  const el = $("liveProgramChart");
  el.querySelectorAll(".chart-bar-item").forEach((item) => {
    const i = Number(item.dataset.index);
    item.classList.toggle("is-active", i === index);
    item.classList.toggle("is-done", i < index);
  });
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
  $("liveProgramSegmentTime").textContent = `${fmtTime(info.segRemaining)} restantes`;
  const next = program.segments[info.index + 1];
  $("liveProgramNextLabel").textContent = next ? `Siguiente: ${next.targetSpm} SPM (${fmtTime(next.durationSec)})` : "Último tramo";
}

async function stopSession() {
  clearInterval(state.sessionTimer);
  stopMetronome();

  const summary = buildSummary();
  renderSummary(summary);
  setLiveScreen("Summary");

  try {
    await saveSessionToServer(summary);
  } catch (err) {
    console.error(err);
    alert("La sesión no se pudo guardar en tu historial: " + describeError(err) + "\nRevisa tu conexión e inténtalo de nuevo desde Historial si hace falta.");
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
  const body = {
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
  };
  const response = await fetch("/api/live-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Error del servidor");
  return data;
}

function renderSummary(s) {
  const rows = [];
  if (s.programName) rows.push(["Programa", s.programName]);
  rows.push(
    ["Duración", fmtTime(s.durationSec)],
    ["Distancia", `${(s.distanceM / 1000).toFixed(2)} km`],
    ["Ritmo promedio", `${fmtPace(s.avgPaceSec500m)} /500m`],
    ["SPM promedio", Math.round(s.avgSpm)],
    ["Potencia promedio", `${Math.round(s.avgPower)} W`],
    ["Calorías", Math.round(s.calories)],
    ["Remadas totales", s.strokes],
    ["Metrónomo", s.metroBpm ? `${s.metroBpm} SPM` : "Desactivado"],
  );
  $("liveSummaryBox").innerHTML = rows
    .map(([k, v]) => `<div class="live-summary-row"><span>${k}</span><strong>${v}</strong></div>`)
    .join("");
  state.lastSummary = s;
}

// ---------- Compartir ----------
function summaryText(s) {
  const d = new Date(s.date);
  return [
    `Remo2 — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    ...(s.programName ? [`Programa: ${s.programName}`] : []),
    `Duración: ${fmtTime(s.durationSec)}`,
    `Distancia: ${(s.distanceM / 1000).toFixed(2)} km`,
    `Ritmo promedio: ${fmtPace(s.avgPaceSec500m)} /500m`,
    `SPM promedio: ${Math.round(s.avgSpm)}`,
    `Potencia promedio: ${Math.round(s.avgPower)} W`,
    `Calorías: ${Math.round(s.calories)}`,
    `Remadas totales: ${s.strokes}`,
  ].join("\n");
}

function buildSummaryCanvas(s) {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 1100;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#03040a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f7f8ff";
  ctx.font = "bold 54px -apple-system, sans-serif";
  ctx.fillText("Remo2", 50, 90);

  const d = new Date(s.date);
  ctx.fillStyle = "#a9adbc";
  ctx.font = "28px -apple-system, sans-serif";
  ctx.fillText(`${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, 50, 140);

  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.moveTo(50, 175);
  ctx.lineTo(850, 175);
  ctx.stroke();

  const rows = [
    ...(s.programName ? [["Programa", s.programName]] : []),
    ["Duración", fmtTime(s.durationSec)],
    ["Distancia", `${(s.distanceM / 1000).toFixed(2)} km`],
    ["Ritmo promedio", `${fmtPace(s.avgPaceSec500m)} /500m`],
    ["SPM promedio", `${Math.round(s.avgSpm)}`],
    ["Potencia promedio", `${Math.round(s.avgPower)} W`],
    ["Calorías", `${Math.round(s.calories)}`],
    ["Remadas totales", `${s.strokes}`],
  ];
  let y = 230;
  rows.forEach(([k, v]) => {
    ctx.fillStyle = "#a9adbc";
    ctx.font = "30px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(k, 50, y);
    ctx.fillStyle = "#f7f8ff";
    ctx.font = "bold 40px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(v, 850, y);
    ctx.textAlign = "left";
    y += 108;
  });
  return canvas;
}

async function shareSummary(summary) {
  if (!summary) return;
  const canvas = buildSummaryCanvas(summary);
  const text = summaryText(summary);

  canvas.toBlob(async (blob) => {
    if (!blob) return alert("No se pudo generar la imagen del resumen.");
    const file = new File([blob], `remo2_${Date.now()}.png`, { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Remo2", text });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: "Remo2", text });
        return;
      }
      throw new Error("navigator.share no disponible");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `remo2_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      alert("Tu navegador no soporta compartir directo — se descargó la imagen, guárdala manualmente.");
    }
  }, "image/png");
}

// ---------- Programas (guardados en el servidor, ligados a tu cuenta) ----------
async function programsApi(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Error del servidor");
  return data;
}

function loadPrograms() {
  return programsApi("/api/programs");
}

async function renderProgramsList() {
  const el = $("liveProgramsList");
  el.innerHTML = `<p class="live-muted">Cargando...</p>`;

  let programs;
  try {
    programs = await loadPrograms();
  } catch (err) {
    el.innerHTML = `<p class="live-muted">No se pudieron cargar los programas: ${describeError(err)}</p>`;
    return;
  }

  if (!programs.length) {
    el.innerHTML = `<p class="live-muted">Sin programas guardados.</p>`;
    return;
  }
  el.innerHTML = programs
    .map((p) => {
      const total = fmtTime(programTotalDuration(p));
      return `<div class="live-list-item">
        <span>${p.name} — ${p.segments.length} tramos — ${total}</span>
        <div class="live-item-actions">
          <button data-id="${p.id}" class="mini-button btnRunProgram">Iniciar</button>
          <button data-id="${p.id}" class="mini-button btnEditProgram">Editar</button>
          <button data-id="${p.id}" class="mini-button danger btnDeleteProgram">Borrar</button>
        </div>
      </div>`;
    })
    .join("");

  el.querySelectorAll(".btnRunProgram").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.device) return alert("Conecta la remadora primero (pestaña Remo en vivo).");
      const program = programs.find((p) => p.id === Number(btn.dataset.id));
      if (!program) return;
      goToTopScreen("live");
      startSession(program);
    });
  });
  el.querySelectorAll(".btnEditProgram").forEach((btn) => {
    btn.addEventListener("click", () => {
      const program = programs.find((p) => p.id === Number(btn.dataset.id));
      if (program) openProgramEditor(program);
    });
  });
  el.querySelectorAll(".btnDeleteProgram").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Borrar este programa?")) return;
      try {
        await programsApi(`/api/programs/${btn.dataset.id}`, { method: "DELETE" });
        renderProgramsList();
      } catch (err) {
        alert("No se pudo borrar: " + describeError(err));
      }
    });
  });
}

function openProgramEditor(existing) {
  state.editingProgramId = existing ? existing.id : null;
  state.editorSegments = existing ? existing.segments.map((s) => ({ ...s })) : [];
  $("liveProgramName").value = existing ? existing.name : "";
  renderSegmentsList();
  setLiveScreen("ProgramEditor");
}

function renderSegmentsList() {
  const el = $("liveSegmentsList");
  if (!state.editorSegments.length) {
    el.innerHTML = `<p class="live-muted">Sin tramos todavía. Agrega el primero arriba.</p>`;
  } else {
    el.innerHTML = state.editorSegments
      .map((seg, i) => `<div class="live-list-item">
        <span>${i + 1}. ${fmtTime(seg.durationSec)} @ ${seg.targetSpm} SPM</span>
        <button data-i="${i}" class="mini-button danger btnRemoveSegment">×</button>
      </div>`)
      .join("");
    el.querySelectorAll(".btnRemoveSegment").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.editorSegments.splice(parseInt(btn.dataset.i, 10), 1);
        renderSegmentsList();
      });
    });
  }
  const total = state.editorSegments.reduce((a, s) => a + s.durationSec, 0);
  $("liveProgramTotal").textContent = state.editorSegments.length ? `Duración total: ${fmtTime(total)}` : "";
}

function addSegment() {
  const min = parseInt($("liveSegMin").value, 10) || 0;
  const sec = parseInt($("liveSegSec").value, 10) || 0;
  const spm = parseInt($("liveSegSpm").value, 10) || 22;
  const durationSec = min * 60 + sec;
  if (durationSec <= 0) return alert("La duración del tramo debe ser mayor a cero.");
  state.editorSegments.push({ durationSec, targetSpm: spm });
  renderSegmentsList();
}

async function saveProgramFromEditor() {
  const name = $("liveProgramName").value.trim();
  if (!name) return alert("Ponle un nombre al programa.");
  if (!state.editorSegments.length) return alert("Agrega al menos un tramo.");

  const body = { name, segments: state.editorSegments };
  try {
    if (state.editingProgramId) {
      await programsApi(`/api/programs/${state.editingProgramId}`, { method: "PUT", body });
    } else {
      await programsApi("/api/programs", { method: "POST", body });
    }
    setLiveScreen("Programs");
    renderProgramsList();
  } catch (err) {
    alert("No se pudo guardar el programa: " + describeError(err));
  }
}

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

function adjustMetroBpm(delta) {
  state.metroBpm = Math.min(40, Math.max(10, state.metroBpm + delta));
  $("liveMetroLive").textContent = `${state.metroBpm} SPM`;
  restartMetronomeIfRunning();
}
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
$("liveBtnSaveProgram").addEventListener("click", saveProgramFromEditor);
$("liveBtnCancelProgram").addEventListener("click", () => setLiveScreen("Programs"));
