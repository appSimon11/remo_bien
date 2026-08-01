// Estado compartido y helpers genéricos usados por el resto de los módulos de "Remo en vivo".

export const $ = (id) => document.getElementById(id);

export const state = {
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
  nextBeepTime: 0,
  sessionStart: null,
  sessionTimer: null,
  keepAliveTimer: null,
  samples: [],
  latest: { distance: 0, pace: null, spm: 0, power: 0, cal: 0, hr: null, strokes: 0, elapsed: 0 },
  editorSegments: [],
  blockSegments: [],
  editingProgramId: null,
  activeProgram: null,
  programSegmentIndex: -1,
  lastSummary: null,
  freeMode: false,
  pendingFreeSummary: null,
};

export function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function fmtPace(secPer500m) {
  if (secPer500m == null || !isFinite(secPer500m) || secPer500m <= 0) return "--:--";
  return fmtTime(secPer500m);
}

export function describeError(err) {
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

export function goToTopScreen(name) {
  const navBtn = document.querySelector(`.nav-button[data-screen="${name}"]`);
  if (navBtn) navBtn.click(); // reutiliza showScreen() de app.js
}

export function setLiveScreen(name) {
  // Solo togglea los paneles dentro de la MISMA pestaña principal (Remo en vivo vs Programas),
  // así cambiar de pestaña para ver programas no pierde el progreso de una sesión en curso.
  const target = $(`liveScreen${name}`);
  const scope = target.closest(".screen") || document;
  scope.querySelectorAll(".live-screen").forEach((el) => el.classList.remove("live-screen-active"));
  target.classList.add("live-screen-active");
}
