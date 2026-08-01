// Metrónomo con "lookahead scheduler" (patrón estándar de Web Audio para tempo preciso):
// en vez de un setInterval que va acumulando desfase con cada beep durante una sesión larga,
// programamos los beeps por adelantado usando el reloj interno del AudioContext, que no se
// desincroniza aunque el hilo principal de JS se retrase un poco.

import { $, state } from "./state.js";

const METRO_SCHEDULE_AHEAD_SEC = 0.15;
const METRO_SCHEDULER_INTERVAL_MS = 30;

function ensureAudioCtx() {
  if (!state.metroAudioCtx) state.metroAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.metroAudioCtx;
}

function scheduleBeepAt(time) {
  const ctx = state.metroAudioCtx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.5, time + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.13);
}

function pulseStrokeBar(periodSec) {
  const el = $("liveStrokeFill");
  if (!el) return;
  el.style.animationDuration = `${periodSec}s`;
  el.classList.remove("animate");
  void el.offsetWidth; // fuerza reflow para reiniciar la animación desde 0
  el.classList.add("animate");
}

function metroSchedulerTick() {
  const ctx = state.metroAudioCtx;
  const periodSec = 60 / state.metroBpm;
  while (state.nextBeepTime < ctx.currentTime + METRO_SCHEDULE_AHEAD_SEC) {
    scheduleBeepAt(state.nextBeepTime);
    const msUntilBeep = Math.max(0, (state.nextBeepTime - ctx.currentTime) * 1000);
    setTimeout(() => pulseStrokeBar(periodSec), msUntilBeep);
    state.nextBeepTime += periodSec;
  }
}

export function startMetronome(bpm) {
  stopMetronome();
  state.metroBpm = bpm;
  const ctx = ensureAudioCtx();
  state.nextBeepTime = ctx.currentTime + 0.05;
  metroSchedulerTick();
  state.metroTimer = setInterval(metroSchedulerTick, METRO_SCHEDULER_INTERVAL_MS);
  state.metroRunning = true;
}

function stopStrokeBar() {
  const el = $("liveStrokeFill");
  if (!el) return;
  el.classList.remove("animate");
  el.style.width = "0%";
}

export function stopMetronome() {
  if (state.metroTimer) clearInterval(state.metroTimer);
  state.metroTimer = null;
  state.metroRunning = false;
  stopStrokeBar();
}

export function restartMetronomeIfRunning() {
  if (state.metroRunning) startMetronome(state.metroBpm);
}

export function adjustMetroBpm(delta) {
  state.metroBpm = Math.min(40, Math.max(10, state.metroBpm + delta));
  $("liveMetroLive").textContent = `${state.metroBpm} SPM`;
  restartMetronomeIfRunning();
}
