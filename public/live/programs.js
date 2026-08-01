// Programas de entrenamiento: lista, editor de tramos, bloques repetibles.

import { $, state, describeError, fmtTime, setLiveScreen, goToTopScreen } from "./state.js";
import { liveApi } from "./api.js";
import { buildProgramChart, programTotalDuration } from "./programChart.js";
import { startSession } from "./session.js";

function loadPrograms() {
  return liveApi("/api/programs");
}

export async function renderProgramsList() {
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
      return `<div class="live-list-item live-list-item-column">
        <div class="live-list-item-row">
          <span>${p.name} — ${p.segments.length} tramos — ${total}</span>
          <div class="live-item-actions">
            <button data-id="${p.id}" class="mini-button btnRunProgram">Iniciar</button>
            <button data-id="${p.id}" class="mini-button btnEditProgram">Editar</button>
            <button data-id="${p.id}" class="mini-button danger btnDeleteProgram">Borrar</button>
          </div>
        </div>
        <div id="programChart-${p.id}" class="live-program-chart"></div>
      </div>`;
    })
    .join("");

  programs.forEach((p) => buildProgramChart(p, $(`programChart-${p.id}`)));

  el.querySelectorAll(".btnRunProgram").forEach((btn) => {
    btn.addEventListener("click", () => {
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
        await liveApi(`/api/programs/${btn.dataset.id}`, { method: "DELETE" });
        renderProgramsList();
      } catch (err) {
        alert("No se pudo borrar: " + describeError(err));
      }
    });
  });
}

export function openProgramEditor(existing) {
  state.editingProgramId = existing ? existing.id : null;
  state.editorSegments = existing ? existing.segments.map((s) => ({ ...s })) : [];
  state.blockSegments = [];
  $("liveProgramName").value = existing ? existing.name : "";
  renderSegmentsList();
  renderBlockSegmentsList();
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
  buildProgramChart({ segments: state.editorSegments }, $("liveEditorChart"));
}

export function addSegment() {
  const min = parseInt($("liveSegMin").value, 10) || 0;
  const sec = parseInt($("liveSegSec").value, 10) || 0;
  const spm = parseInt($("liveSegSpm").value, 10) || 22;
  const durationSec = min * 60 + sec;
  if (durationSec <= 0) return alert("La duración del tramo debe ser mayor a cero.");
  state.editorSegments.push({ durationSec, targetSpm: spm });
  renderSegmentsList();
}

function renderBlockSegmentsList() {
  const el = $("liveBlockSegmentsList");
  if (!state.blockSegments.length) {
    el.innerHTML = `<p class="live-muted">Sin tramos en el bloque. Agrega el primero arriba.</p>`;
  } else {
    el.innerHTML = state.blockSegments
      .map((seg, i) => `<div class="live-list-item">
        <span>${i + 1}. ${fmtTime(seg.durationSec)} @ ${seg.targetSpm} SPM</span>
        <button data-i="${i}" class="mini-button danger btnRemoveBlockSegment">×</button>
      </div>`)
      .join("");
    el.querySelectorAll(".btnRemoveBlockSegment").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.blockSegments.splice(parseInt(btn.dataset.i, 10), 1);
        renderBlockSegmentsList();
      });
    });
  }
}

export function addBlockSegment() {
  const min = parseInt($("liveBlockSegMin").value, 10) || 0;
  const sec = parseInt($("liveBlockSegSec").value, 10) || 0;
  const spm = parseInt($("liveBlockSegSpm").value, 10) || 22;
  const durationSec = min * 60 + sec;
  if (durationSec <= 0) return alert("La duración del tramo debe ser mayor a cero.");
  state.blockSegments.push({ durationSec, targetSpm: spm });
  renderBlockSegmentsList();
}

export function addBlockToProgram() {
  if (!state.blockSegments.length) return alert("Agrega al menos un tramo al bloque.");
  const repeats = parseInt($("liveBlockRepeat").value, 10) || 0;
  if (repeats <= 0) return alert("Las repeticiones deben ser mayores a cero.");
  for (let i = 0; i < repeats; i += 1) {
    for (const seg of state.blockSegments) {
      state.editorSegments.push({ ...seg });
    }
  }
  state.blockSegments = [];
  renderBlockSegmentsList();
  renderSegmentsList();
}

export async function saveProgramFromEditor() {
  const name = $("liveProgramName").value.trim();
  if (!name) return alert("Ponle un nombre al programa.");
  if (!state.editorSegments.length) return alert("Agrega al menos un tramo.");

  const body = { name, segments: state.editorSegments };
  try {
    if (state.editingProgramId) {
      await liveApi(`/api/programs/${state.editingProgramId}`, { method: "PUT", body });
    } else {
      await liveApi("/api/programs", { method: "POST", body });
    }
    setLiveScreen("Programs");
    renderProgramsList();
  } catch (err) {
    alert("No se pudo guardar el programa: " + describeError(err));
  }
}
