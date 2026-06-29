const formatter = new Intl.DateTimeFormat("es-MX", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const periods = ["day", "week", "month", "year"];
const periodLabels = { day: "Día", week: "Semana", month: "Mes", year: "Año" };
const offsets = { day: 0, week: 0, month: 0, year: 0 };
const periodData = {};

let activePeriod = "day";
let requiredTodayKilometers = 0;
let importRows = [];

const today = new Date();
const todayIso = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, "0"),
  String(today.getDate()).padStart(2, "0"),
].join("-");

const $ = (selector) => document.querySelector(selector);

const authScreen = $("#authScreen");
const appShell = $("#appShell");
const dateInput = $("#sessionDate");
const form = $("#sessionForm");
const formMessage = $("#formMessage");
const historyForm = $("#historyForm");
const baselineForm = $("#baselineForm");
const forecastMessage = $("#forecastMessage");
const importForm = $("#importForm");
const importMessage = $("#importMessage");

dateInput.value = todayIso;
$("#todayLabel").textContent = formatter.format(today);
$("#seedDate").value = todayIso;
$("#historyYear").value = today.getFullYear() - 1;

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await login();
});

$("#registerButton").addEventListener("click", async () => {
  setAuthMessage("Creando usuario...", "");
  try {
    const response = await api("/api/auth/register", {
      method: "POST",
      body: {
        username: $("#authUsername").value,
        password: $("#authPassword").value,
      },
    });
    if (!response.ok) throw new Error(response.data.message);
    setAuthMessage("Usuario creado. Ya puedes entrar.", "success");
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  appShell.classList.add("is-hidden");
  authScreen.classList.remove("is-hidden");
});

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.screen, button));
});

document.querySelectorAll(".period-card").forEach((card) => {
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    setActivePeriod(card.dataset.periodCard);
  });
});

document.querySelectorAll(".icon-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const period = button.dataset.period;
    offsets[period] += Number(button.dataset.step);
    setActivePeriod(period);
    await loadPeriod(period);
    renderCharts(periodData[period]);
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const editingId = $("#editingSessionId").value;
  setMessage(editingId ? "Guardando cambios..." : "Guardando sesión...", "");

  const payload = readSessionForm();
  try {
    const response = await api(editingId ? `/api/sessions/${editingId}` : "/api/sessions", {
      method: editingId ? "PUT" : "POST",
      body: payload,
    });
    if (!response.ok) throw new Error(response.data.detail ? `${response.data.message} Detalle: ${response.data.detail}` : response.data.message);

    resetSessionForm();
    setMessage(editingId ? "Sesión actualizada." : "Sesión guardada correctamente.", "success");
    if (!editingId) renderTodayGoalResult(Number(payload.kilometers));
    await refreshDashboard();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

$("#cancelEditButton").addEventListener("click", resetSessionForm);
$("#refreshSessionsButton").addEventListener("click", loadSessions);

$("#sessionsTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const id = button.dataset.id;
  const row = JSON.parse(button.closest("[data-session]").dataset.session);

  if (button.dataset.action === "edit") {
    showScreen("session", document.querySelector('[data-screen="session"]'));
    fillSessionForm(row);
    return;
  }

  if (!window.confirm("¿Eliminar esta sesión?")) return;
  const response = await api(`/api/sessions/${id}`, { method: "DELETE" });
  if (!response.ok) {
    setMessage(response.data.message, "error");
    return;
  }
  await refreshDashboard();
});

historyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setForecastMessage("Guardando histórico...", "");
  try {
    const response = await api("/api/history-years", {
      method: "POST",
      body: {
        year: $("#historyYear").value,
        kilometers: $("#historyKilometers").value,
        durationMinutes: $("#historyMinutes").value,
      },
    });
    if (!response.ok) throw new Error(response.data.detail ? `${response.data.message} Detalle: ${response.data.detail}` : response.data.message);
    setForecastMessage("Histórico guardado.", "success");
    await loadForecastArea();
  } catch (error) {
    setForecastMessage(error.message, "error");
  }
});

baselineForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveBaseline("/api/current-year-baseline");
});

$("#resetYearButton").addEventListener("click", async () => {
  await saveBaseline("/api/current-year-reset");
});

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  importRows = [];
  $("#commitImportButton").disabled = true;
  setImportMessage("Leyendo archivo...", "");

  const file = $("#importFile").files[0];
  if (!file) return setImportMessage("Selecciona un archivo CSV.", "error");
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return setImportMessage("Usa CSV. La plantilla abre en Excel y se puede guardar como CSV.", "error");
  }

  try {
    const text = await file.text();
    const response = await api("/api/import-preview", { method: "POST", body: { text } });
    if (!response.ok) throw new Error(response.data.message);
    importRows = response.data.validRows || [];
    renderImportPreview(response.data);
    $("#commitImportButton").disabled = importRows.length === 0 || response.data.errors.length > 0;
    setImportMessage(
      response.data.errors.length > 0
        ? "Hay observaciones. Corrige el archivo y vuelve a previsualizar."
        : "Todo se ve bien. Puedes guardar la importación.",
      response.data.errors.length > 0 ? "error" : "success",
    );
  } catch (error) {
    setImportMessage(error.message, "error");
  }
});

$("#commitImportButton").addEventListener("click", async () => {
  setImportMessage("Guardando importación...", "");
  try {
    const response = await api("/api/import-sessions", { method: "POST", body: { rows: importRows } });
    if (!response.ok) throw new Error(response.data.message);
    setImportMessage(`Importadas ${response.data.imported} sesiones.`, "success");
    importRows = [];
    $("#commitImportButton").disabled = true;
    await refreshDashboard();
  } catch (error) {
    setImportMessage(error.message, "error");
  }
});

async function api(url, options = {}) {
  const fetchOptions = {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  };
  const response = await fetch(url, fetchOptions);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (response.status === 401) {
    appShell.classList.add("is-hidden");
    authScreen.classList.remove("is-hidden");
  }
  return { ok: response.ok, status: response.status, data };
}

async function boot() {
  const response = await api("/api/auth/me");
  if (response.ok && response.data.authenticated) {
    enterApp(response.data.user);
  } else {
    authScreen.classList.remove("is-hidden");
    appShell.classList.add("is-hidden");
  }
}

async function login() {
  setAuthMessage("Entrando...", "");
  try {
    const response = await api("/api/auth/login", {
      method: "POST",
      body: { username: $("#authUsername").value, password: $("#authPassword").value },
    });
    if (!response.ok) throw new Error(response.data.message);
    setAuthMessage("", "");
    enterApp(response.data.user);
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function enterApp(user) {
  $("#userLabel").textContent = `Usuario: ${user.username}`;
  authScreen.classList.add("is-hidden");
  appShell.classList.remove("is-hidden");
  await refreshDashboard();
}

function showScreen(screen, activeButton) {
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("is-active", item === activeButton));
  document.querySelectorAll(".screen").forEach((view) => view.classList.toggle("is-active", view.dataset.view === screen));
  if (screen === "history") loadSessions();
}

function readSessionForm() {
  return {
    sessionDate: dateInput.value,
    kilometers: $("#kilometers").value,
    strokes: $("#strokes").value,
    calories: $("#calories").value,
    durationMinutes: $("#durationMinutes").value,
  };
}

function fillSessionForm(row) {
  $("#editingSessionId").value = row.id;
  dateInput.value = row.sessionDate;
  $("#kilometers").value = row.kilometers;
  $("#strokes").value = row.strokes;
  $("#calories").value = row.calories;
  $("#durationMinutes").value = row.durationMinutes;
  $("#sessionSubmitButton").textContent = "Guardar cambios";
  $("#cancelEditButton").classList.add("is-visible");
}

function resetSessionForm() {
  form.reset();
  $("#editingSessionId").value = "";
  dateInput.value = todayIso;
  $("#sessionSubmitButton").textContent = "Guardar sesión";
  $("#cancelEditButton").classList.remove("is-visible");
}

function setAuthMessage(message, type) {
  $("#authMessage").textContent = message;
  $("#authMessage").classList.toggle("is-success", type === "success");
  $("#authMessage").classList.toggle("is-error", type === "error");
}

function setMessage(message, type) {
  formMessage.textContent = message;
  formMessage.classList.toggle("is-success", type === "success");
  formMessage.classList.toggle("is-error", type === "error");
}

function setForecastMessage(message, type) {
  forecastMessage.textContent = message;
  forecastMessage.classList.toggle("is-success", type === "success");
  forecastMessage.classList.toggle("is-error", type === "error");
}

function setImportMessage(message, type) {
  importMessage.textContent = message;
  importMessage.classList.toggle("is-success", type === "success");
  importMessage.classList.toggle("is-error", type === "error");
}

function formatKm(value) {
  return `${Number(value || 0).toLocaleString("es-MX", { maximumFractionDigits: 2 })} km`;
}

function formatSpeed(value) {
  return `${Number(value || 0).toLocaleString("es-MX", { maximumFractionDigits: 2 })} km/h`;
}

function formatCalories(value) {
  return Number(value || 0).toLocaleString("es-MX", { maximumFractionDigits: 2 });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("es-MX", { maximumFractionDigits: 2 });
}

function formatMinutes(value) {
  const minutes = Number(value || 0);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
  return `${formatNumber(minutes)} min`;
}

function formatPace(minutesPer500m) {
  const totalSeconds = Math.round(Number(minutesPer500m || 0) * 60);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function loadPeriod(period) {
  const response = await api(`/api/stats?period=${period}&offset=${offsets[period]}`);
  if (!response.ok) {
    const detail = response.data.detail ? ` Detalle: ${response.data.detail}` : "";
    throw new Error(`${response.data.message || "No se pudo leer la base de datos."}${detail}`);
  }
  periodData[period] = response.data;
  renderPeriodCard(response.data);
}

async function refreshDashboard() {
  try {
    await Promise.all(periods.map((period) => loadPeriod(period)));
    renderYearPreview();
    renderCharts(periodData[activePeriod]);
    await Promise.all([loadForecastArea(), loadSessions()]);
    setMessage("", "");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function loadSessions() {
  const response = await api("/api/sessions?limit=120");
  if (!response.ok) return;
  renderSessions(response.data);
}

async function loadForecastArea() {
  const [forecastResponse, historyResponse, yearMapResponse] = await Promise.all([
    api("/api/forecast"),
    api("/api/history-years"),
    api("/api/year-map"),
  ]);
  if (!forecastResponse.ok) throw new Error(forecastResponse.data.message || "No se pudo leer el forecast.");
  if (!historyResponse.ok) throw new Error(historyResponse.data.message || "No se pudo leer el histórico.");
  if (!yearMapResponse.ok) throw new Error(yearMapResponse.data.message || "No se pudo leer el mapa anual.");
  renderForecast(forecastResponse.data);
  renderHistory(historyResponse.data);
  renderYearMap(yearMapResponse.data);
}

function setActivePeriod(period) {
  activePeriod = period;
  document.querySelectorAll(".period-card").forEach((card) => card.classList.toggle("is-active", card.dataset.periodCard === period));
  if (periodData[period]) renderCharts(periodData[period]);
}

function renderPeriodCard(data) {
  $(`#${data.period}Title`).textContent = data.range.title;
  $(`#${data.period}Summary`).innerHTML = `
    <span>${formatNumber(data.summary.sessions)} sesiones</span>
    <span>${formatKm(data.summary.kilometers)}</span>
    <span>${formatMinutes(data.summary.durationMinutes)}</span>
    <span>${formatPace(data.summary.pace500m)} /500m</span>
  `;
}

function renderYearPreview() {
  const year = periodData.year?.summary || {};
  $("#totalSessions").textContent = formatNumber(year.sessions);
  $("#yearKm").textContent = formatKm(year.kilometers);
  $("#yearTime").textContent = formatMinutes(year.durationMinutes);
  $("#yearPace").textContent = formatPace(year.pace500m);
  $("#yearSpm").textContent = formatNumber(year.strokesPerMinute);
  $("#yearCaloriesKm").textContent = formatNumber(year.caloriesPerKm);
}

function renderCharts(data) {
  if (!data) return;
  $("#activePeriodTitle").textContent = `${periodLabels[data.period]} · ${data.range.title}`;
  $("#kilometersTotal").textContent = formatKm(data.summary.kilometers);
  $("#strokesTotal").textContent = formatNumber(data.summary.strokes);
  $("#caloriesTotal").textContent = formatCalories(data.summary.calories);
  $("#timeTotal").textContent = formatMinutes(data.summary.durationMinutes);
  renderChart("kilometersChart", data.chart, "kilometers", formatKm);
  renderChart("strokesChart", data.chart, "strokes", formatNumber);
  renderChart("caloriesChart", data.chart, "calories", formatCalories);
  renderChart("timeChart", data.chart, "durationMinutes", formatMinutes);
}

function renderForecast(data) {
  $("#goalKilometers").textContent = formatKm(data.forecast.goalKilometers);
  $("#currentKilometers").textContent = formatKm(data.current.totalKilometers);
  $("#remainingKilometers").textContent = formatKm(data.forecast.remainingKilometers);
  $("#requiredDailyKilometers").textContent = formatKm(data.forecast.requiredDailyKilometers);
  $("#forecastAverageSpeed").textContent = formatSpeed(data.forecast.averageSpeed);
  $("#forecastDailyAverage").textContent = formatKm(data.forecast.dailyAverage);
  $("#seedDate").value = data.baseline.seedDate || todayIso;
  $("#initialKilometers").value = data.baseline.initialKilometers || "";
  $("#initialMinutes").value = data.baseline.initialDurationMinutes || "";
  const progress = Math.max(0, Math.min(Number(data.forecast.progressPercent || 0), 100));
  requiredTodayKilometers = Number(data.forecast.requiredDailyKilometers || 0);
  $("#goalProgressLabel").textContent = `${progress.toFixed(1)}%`;
  $("#goalFill").style.width = `${progress}%`;
  $("#goalNeededDaily").textContent = `Necesario hoy: ${formatKm(requiredTodayKilometers)} / día`;
  $("#todayGoalValue").textContent = formatKm(requiredTodayKilometers);
  renderGoalProbability(data.forecast.goalProbability, data.forecast.requiredDailyKilometers);
}

function renderGoalProbability(probability, requiredDailyKilometers) {
  const card = $("#goalProbabilityCard");
  const value = $("#goalProbabilityValue");
  const fill = $("#goalProbabilityFill");
  const text = $("#goalProbabilityText");

  if (!probability?.available) {
    card.classList.add("is-empty");
    value.textContent = "--";
    fill.style.width = "0%";
    text.textContent = probability?.message || "Guarda años históricos para estimar la probabilidad.";
    return;
  }

  const percent = Math.max(0, Math.min(Number(probability.percent || 0), 100));
  card.classList.remove("is-empty");
  value.textContent = `${percent.toFixed(0)}%`;
  fill.style.width = `${percent}%`;
  text.textContent =
    `${probability.message} Necesitas ${formatKm(requiredDailyKilometers)} al día; tu promedio histórico es ${formatKm(probability.historicalDailyAverage)} en ${formatNumber(probability.historicalYears)} año(s).`;
}

function renderTodayGoalResult(kilometers) {
  const result = $("#todayGoalResult");
  const goalCard = $("#todayGoalCard");
  const achieved = kilometers >= requiredTodayKilometers;
  goalCard.classList.toggle("is-hit", achieved);
  goalCard.classList.toggle("is-miss", !achieved);
  result.textContent = achieved ? "Lograda" : "Faltó";
}

function renderSessions(rows) {
  $("#sessionsCount").textContent = formatNumber(rows.length);
  if (rows.length === 0) {
    $("#sessionsTable").innerHTML = `<div class="empty-chart">Sin sesiones</div>`;
    return;
  }
  $("#sessionsTable").innerHTML = `
    <div class="sessions-row sessions-head">
      <span>Fecha</span><span>Km</span><span>Tiempo</span><span>Ritmo</span><span>Pal/min</span><span>Cal/km</span><span></span>
    </div>
    ${rows.map(renderSessionRow).join("")}
  `;
}

function renderSessionRow(row) {
  return `
    <div class="sessions-row" data-session='${JSON.stringify(row)}'>
      <span>${row.sessionDate}</span>
      <span>${formatKm(row.kilometers)}</span>
      <span>${formatMinutes(row.durationMinutes)}</span>
      <span>${formatPace(row.pace500m)}</span>
      <span>${formatNumber(row.strokesPerMinute)}</span>
      <span>${formatNumber(row.caloriesPerKm)}</span>
      <span class="row-actions">
        <button class="mini-button" data-action="edit" data-id="${row.id}" type="button">Editar</button>
        <button class="mini-button danger" data-action="delete" data-id="${row.id}" type="button">Borrar</button>
      </span>
    </div>
  `;
}

function renderHistory(rows) {
  $("#historyCount").textContent = formatNumber(rows.length);
  if (rows.length === 0) {
    $("#historyTable").innerHTML = `<div class="empty-chart">Sin años guardados</div>`;
    return;
  }
  $("#historyTable").innerHTML = `
    <div class="history-row history-head"><span>Año</span><span>Kilómetros</span><span>Tiempo</span><span>Velocidad</span><span>Promedio diario</span></div>
    ${rows
      .map(
        (row) => `
          <div class="history-row">
            <span>${row.year}</span><span>${formatKm(row.kilometers)}</span><span>${formatMinutes(row.durationMinutes)}</span>
            <span>${formatSpeed(row.averageSpeed)}</span><span>${formatKm(row.dailyAverage)}</span>
          </div>
        `,
      )
      .join("")}
  `;
}

function renderYearMap(data) {
  $("#yearMapTitle").textContent = `${data.year} · día ${data.todayIndex}`;
  $("#yearMap").innerHTML = data.days
    .map((day) => `<span class="year-day is-${day.status}" title="Día ${day.index} · ${day.date}" aria-label="Día ${day.index}: ${day.status}"></span>`)
    .join("");
}

function renderChart(chartId, rows, key, formatterFn) {
  const chart = $(`#${chartId}`);
  const max = Math.max(...rows.map((row) => Number(row[key] || 0)), 1);
  if (rows.length === 0) {
    chart.innerHTML = `<div class="empty-chart">Sin sesiones</div>`;
    return;
  }
  chart.innerHTML = rows
    .map((row) => {
      const value = Number(row[key] || 0);
      const height = Math.max((value / max) * 100, 4);
      return `<div class="bar-wrap"><div class="bar" title="${formatterFn(value)}" style="height: ${height}%"></div><div class="bar-label">${row.label}</div></div>`;
    })
    .join("");
}

async function saveBaseline(url) {
  const info = await api("/api/current-year-reset-info");
  const sessions = info.ok ? info.data.sessions : 0;
  const confirmed = window.confirm(`Esto borrará ${sessions} sesiones del año actual. Escribe BORRAR en el campo de confirmación para continuar.`);
  if (!confirmed) return;
  setForecastMessage("Guardando base inicial...", "");
  try {
    const response = await api(url, {
      method: url.includes("reset") ? "POST" : "PUT",
      body: {
        seedDate: $("#seedDate").value,
        initialKilometers: $("#initialKilometers").value,
        initialDurationMinutes: $("#initialMinutes").value,
        confirmationText: $("#resetConfirm").value,
      },
    });
    if (!response.ok) throw new Error(response.data.detail ? `${response.data.message} Detalle: ${response.data.detail}` : response.data.message);
    setForecastMessage(`Base guardada. Sesiones borradas: ${response.data.deletedSessions}.`, "success");
    $("#resetConfirm").value = "";
    await refreshDashboard();
  } catch (error) {
    setForecastMessage(error.message, "error");
  }
}

function renderImportPreview(data) {
  $("#importCount").textContent = `${data.validRows.length} de ${data.totalRows} filas válidas`;
  const errors = data.errors.length
    ? `<div class="import-errors">${data.errors.map((error) => `<p>${error}</p>`).join("")}</div>`
    : "";
  const table = data.validRows.length
    ? `
      <div class="sessions-row sessions-head"><span>Fecha</span><span>Km</span><span>Paladas</span><span>Calorías</span><span>Tiempo</span></div>
      ${data.validRows
        .slice(0, 40)
        .map(
          (row) => `
            <div class="sessions-row compact-row">
              <span>${row.sessionDate}</span><span>${formatKm(row.kilometers)}</span><span>${formatNumber(row.strokes)}</span>
              <span>${formatCalories(row.calories)}</span><span>${formatMinutes(row.durationMinutes)}</span>
            </div>
          `,
        )
        .join("")}
    `
    : `<div class="empty-chart">Sin filas válidas</div>`;
  $("#importPreview").innerHTML = `${errors}${table}`;
}

boot();
