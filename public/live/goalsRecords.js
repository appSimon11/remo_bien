// Pestaña "Metas y Récords": metas personalizadas + récords automáticos + celebración al romperlos.

import { $, describeError, fmtTime, fmtPace } from "./state.js";
import { liveApi } from "./api.js";

function formatGoalValue(goal) {
  if (goal.metric === "duration_min") return `${Math.round(goal.currentValue)} / ${Math.round(goal.targetValue)} min`;
  if (goal.metric === "sessions_count") return `${Math.round(goal.currentValue)} / ${Math.round(goal.targetValue)} sesiones`;
  if (goal.metric === "calories") return `${Math.round(goal.currentValue)} / ${Math.round(goal.targetValue)} kcal`;
  if (goal.metric === "strokes") return `${Math.round(goal.currentValue)} / ${Math.round(goal.targetValue)} paladas`;
  return `${goal.currentValue.toFixed(1)} / ${goal.targetValue.toFixed(1)} km`;
}

export async function renderGoalsList() {
  const el = $("goalsList");
  el.innerHTML = `<p class="live-muted">Cargando...</p>`;
  let goals;
  try {
    goals = await liveApi("/api/goals");
  } catch (err) {
    el.innerHTML = `<p class="live-muted">No se pudieron cargar las metas: ${describeError(err)}</p>`;
    return;
  }
  $("goalsCount").textContent = goals.length;
  if (!goals.length) {
    el.innerHTML = `<p class="live-muted">Sin metas todavía.</p>`;
    return;
  }
  el.innerHTML = goals
    .map(
      (g) => `<div class="goal-item ${g.completed ? "is-complete" : ""}">
        <div class="goal-item-head">
          <strong>${g.completed ? "🏆 " : ""}${g.name}</strong>
          <div class="live-item-actions">
            <button data-id="${g.id}" class="mini-button goal-adjust">Ajustar avance</button>
            <button data-id="${g.id}" class="mini-button danger goal-delete">Borrar</button>
          </div>
        </div>
        <div class="goal-track"><div class="goal-fill-bar" style="width:${g.percent}%"></div></div>
        <div class="goal-meta"><span>${formatGoalValue(g)}</span><span>${g.percent}%</span></div>
      </div>`,
    )
    .join("");
  el.querySelectorAll(".goal-adjust").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const goal = goals.find((g) => g.id === Number(btn.dataset.id));
      const input = prompt(
        `¿Cuánto llevas en realidad de "${goal.name}"? (Útil si el total calculado incluye datos que no le corresponden, ej. otra remadora)`,
        Math.round(goal.currentValue),
      );
      if (input == null) return;
      const currentValue = Number(input);
      if (!Number.isFinite(currentValue) || currentValue < 0) return alert("Captura un número válido.");
      try {
        await liveApi(`/api/goals/${btn.dataset.id}/adjust`, { method: "PUT", body: { currentValue } });
        renderGoalsList();
      } catch (err) {
        alert("No se pudo ajustar: " + describeError(err));
      }
    });
  });
  el.querySelectorAll(".goal-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Borrar esta meta?")) return;
      try {
        await liveApi(`/api/goals/${btn.dataset.id}`, { method: "DELETE" });
        renderGoalsList();
      } catch (err) {
        alert("No se pudo borrar: " + describeError(err));
      }
    });
  });
}

function formatRecordValue(def, value) {
  // pace500m viene de la BD en MINUTOS por 500m (igual que en el resto de la app), no en segundos.
  if (def.unit === "/500m") return fmtPace(value * 60);
  if (def.unit === "min") return fmtTime(value * 60);
  if (Number.isInteger(value)) return `${value} ${def.unit}`;
  return `${value.toFixed(1)} ${def.unit}`;
}

export async function renderRecordsGrid() {
  const el = $("recordsGrid");
  el.innerHTML = `<p class="live-muted">Cargando...</p>`;
  let data;
  try {
    data = await liveApi("/api/records");
  } catch (err) {
    el.innerHTML = `<p class="live-muted">No se pudieron cargar los récords: ${describeError(err)}</p>`;
    return;
  }
  const sessionTiles = data.defs
    .map((def) => {
      const record = data.records[def.key];
      if (!record) {
        return `<div class="record-tile is-empty"><div class="record-value">--</div><div class="record-label">${def.label}</div></div>`;
      }
      return `<div class="record-tile">
        <div class="record-value">${formatRecordValue(def, record.value)}</div>
        <div class="record-label">${def.label}</div>
        <div class="record-date">${record.sessionDate}</div>
      </div>`;
    })
    .join("");

  const pb = data.periodBests || {};
  const weekLabel = (period) => {
    const year = Math.floor(period / 100);
    const week = period % 100;
    return `Semana ${week}, ${year}`;
  };
  const monthLabel = (period) => {
    const [y, m] = period.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("es-MX", { month: "long", year: "numeric" });
  };

  const periodTiles = [
    pb.bestWeek
      ? `<div class="record-tile"><div class="record-value">${pb.bestWeek.total.toFixed(1)} km</div><div class="record-label">Mejor semana</div><div class="record-date">${weekLabel(Number(pb.bestWeek.period))}</div></div>`
      : `<div class="record-tile is-empty"><div class="record-value">--</div><div class="record-label">Mejor semana</div></div>`,
    pb.bestMonth
      ? `<div class="record-tile"><div class="record-value">${pb.bestMonth.total.toFixed(1)} km</div><div class="record-label">Mejor mes</div><div class="record-date">${monthLabel(pb.bestMonth.period)}</div></div>`
      : `<div class="record-tile is-empty"><div class="record-value">--</div><div class="record-label">Mejor mes</div></div>`,
    `<div class="record-tile"><div class="record-value">${Number(data.lifetimeKilometers || 0).toFixed(1)} km</div><div class="record-label">Km a la fecha</div></div>`,
    `<div class="record-tile"><div class="record-value">${Math.round(Number(data.lifetimeCalories || 0))} kcal</div><div class="record-label">Calorías a la fecha</div></div>`,
  ].join("");

  el.innerHTML = sessionTiles + periodTiles;
}

export function showCelebrationIfAny(brokenRecords, goalsCompleted) {
  const items = [
    ...(brokenRecords || []).map((r) => `🏅 Nuevo récord — ${r.label}: ${formatRecordValue(r, r.value)}`),
    ...(goalsCompleted || []).map((g) => `🎯 ¡Meta cumplida! ${g.name}`),
  ];
  if (!items.length) return;
  $("celebrateList").innerHTML = items.map((t) => `<div class="celebrate-item">${t}</div>`).join("");
  $("celebrateOverlay").classList.remove("is-hidden");
}

export function hideCelebration() {
  $("celebrateOverlay").classList.add("is-hidden");
}
