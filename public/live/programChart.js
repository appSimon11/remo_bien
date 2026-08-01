// Matemática y dibujo de la gráfica de barras de SPM de un programa (se usa en vivo,
// en la lista de programas y en el editor).

import { $, state } from "./state.js";

export function programTotalDuration(program) {
  return program.segments.reduce((a, s) => a + s.durationSec, 0);
}

export function segmentAtElapsed(program, elapsedSec) {
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

function spmToHeightPct(spm, minSpm, maxSpm) {
  const t = maxSpm > minSpm ? (spm - minSpm) / (maxSpm - minSpm) : 0.5;
  return Math.round(30 + Math.max(0, Math.min(1, t)) * 70);
}

export function buildProgramChart(program, el) {
  if (!el) return;
  if (!program.segments.length) {
    el.innerHTML = "";
    return;
  }
  const spms = program.segments.map((s) => s.targetSpm);
  const minSpm = Math.min(...spms);
  const maxSpm = Math.max(...spms);
  if (el === $("liveProgramChart")) {
    state.chartMinSpm = minSpm;
    state.chartMaxSpm = maxSpm;
  }

  el.innerHTML = program.segments
    .map((seg, i) => {
      const t = maxSpm > minSpm ? (seg.targetSpm - minSpm) / (maxSpm - minSpm) : 0.5;
      const heightPct = spmToHeightPct(seg.targetSpm, minSpm, maxSpm);
      const [r, g, b] = zoneColor(t);
      return `<div class="chart-bar-item" data-index="${i}" style="flex-grow:${seg.durationSec}">
        <span class="chart-bar-label">${seg.targetSpm}</span>
        <div class="chart-bar" style="height:${heightPct}%; background: linear-gradient(180deg, rgba(${r},${g},${b},1), rgba(${r},${g},${b},0.55));"></div>
      </div>`;
    })
    .join("");
}

export function updateProgramChartActive(index) {
  const el = $("liveProgramChart");
  el.querySelectorAll(".chart-bar-item").forEach((item) => {
    const i = Number(item.dataset.index);
    item.classList.toggle("is-active", i === index);
    item.classList.toggle("is-done", i < index);
  });
}
