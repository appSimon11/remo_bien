const USER_DEFAULT_POOLS = {
  Andres: ["rojo", "negro"],
  Sandra: ["UNI"]
};
const COLORS = ["#16d9f4", "#ff4fa1", "#2d7cff", "#27e49f", "#ffd166", "#9b7bff"];
const DAILY_RED_MAX = 40;
const DAILY_YELLOW_MAX = 50;
const DAILY_GOAL = DAILY_YELLOW_MAX + 1;
const sections = ["capture", "stats", "forecast", "database"];

let activeRange = "all";
let currentUser = null;
let rowsCache = [];
let pendingImportRows = [];

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});
const dateLabel = new Intl.DateTimeFormat("es-MX", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric"
});

const todayISO = () => new Date().toISOString().slice(0, 10);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar la operación.");
  return data;
}

function loadRows() {
  return rowsCache;
}

async function refreshRows() {
  const data = await api("/api/rows");
  rowsCache = data.rows || [];
  renderAll();
}

function defaultPools() {
  return USER_DEFAULT_POOLS[currentUser?.username] || [];
}

function normalizePoolName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function sortRows(rows) {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.pool.localeCompare(b.pool));
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function getPools(rows) {
  const names = [...new Set(rows.map((row) => row.pool))];
  return names.length ? names : defaultPools();
}

function latestRowsByDate(rows, date) {
  return rows.filter((row) => row.date === date);
}

function previousDate(rows, date) {
  return [...new Set(rows.map((row) => row.date).filter((item) => item < date))].sort().at(-1);
}

function totalForDate(rows, date) {
  return latestRowsByDate(rows, date).reduce((sum, row) => sum + row.daily, 0);
}

function renderPoolInputs() {
  const rows = loadRows();
  const pools = getPools(rows);
  const latestByPool = new Map();
  for (const row of rows) latestByPool.set(row.pool, row.total);

  $("#poolInputs").innerHTML = pools.map((pool, index) => renderPoolInputRow(pool, latestByPool.get(pool), index)).join("");
}

function renderPoolInputRow(pool, total = "", index = 0) {
  return `
    <div class="pool-input-row">
      <label>
        Pool
        <input name="pool" value="${escapeHtml(pool)}" required />
      </label>
      <label>
        Ganancia acumulada
        <input name="total" type="number" step="0.01" min="0" value="${total ?? ""}" required />
      </label>
      <button class="icon-button" type="button" title="Quitar pool" data-remove-pool="${index}">×</button>
    </div>
  `;
}

function renderCapture() {
  const rows = loadRows();
  const date = $("#captureDate").value || todayISO();
  const todayRows = latestRowsByDate(rows, date);
  const prevDate = previousDate(rows, date);
  const todayTotal = totalForDate(rows, date);
  const previousTotal = prevDate ? totalForDate(rows, prevDate) : 0;
  const diff = todayTotal - previousTotal;

  $("#todayTotalGain").textContent = money.format(todayTotal);
  const icon = $("#totalComparisonIcon");
  icon.className = "comparison neutral";
  icon.textContent = "•";

  if (todayRows.length && prevDate) {
    icon.className = `comparison ${diff >= 0 ? "up" : "down"}`;
    icon.textContent = diff >= 0 ? "✓" : "×";
    $("#todayDeltaText").textContent = `${diff >= 0 ? "Arriba" : "Abajo"} ${money.format(Math.abs(diff))} contra ${prevDate}`;
  } else if (todayRows.length) {
    $("#todayDeltaText").textContent = "Primer registro disponible para comparar.";
  } else {
    $("#todayDeltaText").textContent = "Sin captura para esta fecha.";
  }

  $("#todayBreakdown").innerHTML = todayRows.length
    ? todayRows
        .map(
          (row) => `
            <div class="mini-row">
              <span>${escapeHtml(row.pool)}</span>
              <strong>${money.format(row.daily)}</strong>
              <span class="muted">Acum. ${money.format(row.adjustedTotal ?? row.total)}</span>
              <span class="${row.modified ? "reset-tag" : "muted"}">${row.modified ? "Pool modificado" : "Normal"}</span>
            </div>
          `
        )
        .join("")
    : `<div class="empty-state">Guarda una captura para ver el desglose del día.</div>`;
  renderGoalProbability(rows, date, todayTotal);
  renderYearThresholdMap(rows, date);
}

function renderGoalProbability(rows, selectedDate, selectedTotal) {
  const probability = goalProbability(rows, selectedDate);
  const currentStatus =
    selectedTotal >= DAILY_GOAL
      ? `Hoy ya supera la meta de ${money.format(DAILY_GOAL)}.`
      : selectedTotal > 0
        ? `Hoy faltan ${money.format(DAILY_GOAL - selectedTotal)} para llegar a la meta.`
        : `La meta diaria es ${money.format(DAILY_GOAL)}.`;

  if (!probability.available) {
    $("#goalProbability").innerHTML = `
      <div class="probability-top">
        <span>Probabilidad de cumplir meta</span>
        <strong>--</strong>
      </div>
      <p>${currentStatus} Aún faltan más días de historial para estimar una probabilidad.</p>
    `;
    return;
  }

  $("#goalProbability").innerHTML = `
    <div class="probability-top">
      <span>Probabilidad de cumplir meta</span>
      <strong>${probability.percent.toFixed(0)}%</strong>
    </div>
    <div class="probability-track" aria-label="Probabilidad de cumplir meta">
      <div style="width: ${probability.percent}%"></div>
    </div>
    <p>${currentStatus} Historial: ${probability.successes} de ${probability.days} días llegaron a ${money.format(DAILY_GOAL)} o más. ${probability.signal}</p>
  `;
}

function goalProbability(rows, selectedDate) {
  const historical = dailySeries(rows).filter((item) => item.date < selectedDate);
  if (historical.length < 3) return { available: false };

  const successes = historical.filter((item) => item.value >= DAILY_GOAL).length;
  const baseRate = successes / historical.length;
  const recent = historical.slice(-14);
  const recentSuccesses = recent.filter((item) => item.value >= DAILY_GOAL).length;
  const recentRate = recent.length ? recentSuccesses / recent.length : baseRate;
  const percent = Math.max(0, Math.min((baseRate * 0.7 + recentRate * 0.3) * 100, 100));
  const signal =
    recent.length >= 5 && recentRate > baseRate
      ? "La racha reciente viene mejor que el promedio."
      : recent.length >= 5 && recentRate < baseRate
        ? "La racha reciente viene más baja que el promedio."
        : "La racha reciente está cerca del promedio.";

  return {
    available: true,
    percent,
    successes,
    days: historical.length,
    signal
  };
}

function renderStats() {
  const rows = filterRowsByRange(loadRows());
  const pools = [...new Set(rows.map((row) => row.pool))];
  $("#realTotalStats").innerHTML = renderRealTotalStats(rows);
  $("#combinedStats").innerHTML = renderCombinedStats(rows);
  $("#poolStats").innerHTML = pools.length
    ? pools.map((pool, index) => renderPoolCard(pool, rows.filter((row) => row.pool === pool), COLORS[index % COLORS.length])).join("")
    : `<div class="empty-state">Importa o captura datos para ver estadísticas.</div>`;
}

function filterRowsByRange(rows) {
  if (activeRange === "all" || !rows.length) return rows;
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const allowed = new Set(dates.slice(-Number(activeRange)));
  return rows.filter((row) => allowed.has(row.date));
}

function dailySeries(rows) {
  const byDate = new Map();
  for (const row of rows) byDate.set(row.date, round2((byDate.get(row.date) || 0) + row.daily));
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

function cumulativeSeries(rows) {
  let runningTotal = 0;
  return dailySeries(rows).map((item) => {
    runningTotal = round2(runningTotal + item.value);
    return { date: item.date, value: runningTotal };
  });
}

function metrics(series) {
  const values = series.map((item) => item.value);
  if (!values.length) return { max: 0, min: 0, average: 0, weekAverage: 0, total: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    max: Math.max(...values),
    min: Math.min(...values),
    average: total / values.length,
    weekAverage: calendarWeekAverage(series),
    total
  };
}

function calendarWeekAverage(series) {
  if (!series.length) return 0;
  const today = parseLocalDate(todayISO());
  const weekStart = mondayStart(today);
  const weekValues = series
    .filter((item) => {
      const date = parseLocalDate(item.date);
      return date >= weekStart && date <= today;
    })
    .map((item) => item.value);
  return weekValues.length ? weekValues.reduce((sum, value) => sum + value, 0) / weekValues.length : 0;
}

function renderCombinedStats(rows) {
  const series = dailySeries(rows);
  const data = metrics(series);
  return `
    <div class="card-top">
      <div>
        <p class="eyebrow">Todos los pools como uno solo</p>
        <strong>Rendimiento combinado</strong>
      </div>
      <span class="muted">${series.length} días</span>
    </div>
    ${renderChart(series, "#16d9f4")}
    ${renderMetrics(data)}
  `;
}

function renderRealTotalStats(rows) {
  const daily = dailySeries(rows);
  const cumulative = cumulativeSeries(rows);
  const total = cumulative.at(-1)?.value || 0;
  const bestDay = daily.length ? Math.max(...daily.map((item) => item.value)) : 0;
  const average = daily.length ? daily.reduce((sum, item) => sum + item.value, 0) / daily.length : 0;
  return `
    <div class="card-top">
      <div>
        <p class="eyebrow">Suma real de ganancias</p>
        <strong>Ganancia real acumulada</strong>
      </div>
      <span class="muted">${daily.length} días</span>
    </div>
    ${renderChart(cumulative, "#27e49f", { showDateGuides: true })}
    <div class="metric-grid">
      <div class="metric-box"><span>Total real</span><strong>${money.format(total)}</strong></div>
      <div class="metric-box"><span>Mejor día</span><strong>${money.format(bestDay)}</strong></div>
      <div class="metric-box"><span>Promedio diario</span><strong>${money.format(average)}</strong></div>
      <div class="metric-box"><span>Días</span><strong>${daily.length}</strong></div>
    </div>
  `;
}

function renderPoolCard(pool, rows, color) {
  const series = dailySeries(rows);
  return `
    <article class="pool-card">
      <div class="card-top">
        <strong>${escapeHtml(pool)}</strong>
        <span class="muted">${series.length} días</span>
      </div>
      ${renderChart(series, color)}
      ${renderMetrics(metrics(series))}
    </article>
  `;
}

function renderMetrics(data) {
  return `
    <div class="metric-grid">
      <div class="metric-box"><span>Máximo</span><strong>${money.format(data.max)}</strong></div>
      <div class="metric-box"><span>Mínimo</span><strong>${money.format(data.min)}</strong></div>
      <div class="metric-box"><span>Media</span><strong>${money.format(data.average)}</strong></div>
      <div class="metric-box"><span>Promedio semana</span><strong>${money.format(data.weekAverage)}</strong></div>
    </div>
  `;
}

function renderYearThresholdMap(rows, selectedDate) {
  const selected = parseLocalDate(selectedDate || todayISO());
  const year = selected.getFullYear();
  const today = parseLocalDate(todayISO());
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const firstGridDay = mondayStart(yearStart);
  const totalDays = differenceInDays(yearEnd, firstGridDay) + 1;
  const gridDays = Math.ceil(totalDays / 7) * 7;
  const totalsByDate = new Map(dailySeries(rows).map((item) => [item.date, item.value]));
  const selectedDay = dayOfYear(selected);
  const yearRows = [...totalsByDate.entries()].filter(([date]) => date.startsWith(`${year}-`));
  const redDays = yearRows.filter(([, value]) => value <= DAILY_RED_MAX).length;
  const yellowDays = yearRows.filter(([, value]) => value > DAILY_RED_MAX && value <= DAILY_YELLOW_MAX).length;
  const greenDays = yearRows.filter(([, value]) => value > DAILY_YELLOW_MAX).length;

  const cells = Array.from({ length: gridDays }, (_, index) => {
    const date = addDays(firstGridDay, index);
    const iso = toISODate(date);
    const isOutsideYear = date.getFullYear() !== year;
    const value = totalsByDate.get(iso);
    const isFuture = date > today;
    const status =
      isOutsideYear || isFuture || value === undefined
        ? "empty"
        : value <= DAILY_RED_MAX
          ? "red"
          : value <= DAILY_YELLOW_MAX
            ? "yellow"
            : "green";
    const isSelected = iso === selectedDate;
    const title = isOutsideYear ? "" : `${iso}: ${value === undefined ? "sin dato" : money.format(value)}`;
    return `<span class="year-cell ${status}${isSelected ? " selected" : ""}" title="${escapeHtml(title)}"></span>`;
  }).join("");

  $("#yearThresholdMap").innerHTML = `
    <div class="year-map-head">
      <div>
        <strong>Mapa del año</strong>
        <span>${greenDays} verdes · ${yellowDays} amarillos · ${redDays} rojos</span>
      </div>
      <strong>${year} · día ${selectedDay}</strong>
    </div>
    <div class="year-map-legend">
      <span><i class="green"></i> ${money.format(51)} o más</span>
      <span><i class="yellow"></i> ${money.format(41)} a ${money.format(50)}</span>
      <span><i class="red"></i> ${money.format(40)} o menos</span>
    </div>
    <div class="year-map-grid" aria-label="Mapa anual de meta diaria">${cells}</div>
  `;
}

function parseLocalDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function mondayStart(date) {
  const start = new Date(date);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function differenceInDays(end, start) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((mondaySafe(end) - mondaySafe(start)) / msPerDay);
}

function mondaySafe(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayOfYear(date) {
  return differenceInDays(date, new Date(date.getFullYear(), 0, 1)) + 1;
}

function renderChart(series, color, options = {}) {
  if (!series.length) return `<div class="chart empty-state">Sin datos para graficar.</div>`;
  const width = 640;
  const height = 170;
  const pad = 16;
  const bottomPad = options.showDateGuides ? 34 : pad;
  const values = series.map((item) => item.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = series.map((item, index) => {
    const x = series.length === 1 ? width / 2 : pad + (index / (series.length - 1)) * (width - pad * 2);
    const y = height - bottomPad - ((item.value - min) / span) * (height - pad - bottomPad);
    return [round2(x), round2(y)];
  });
  const line = points.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
  const baseline = height - bottomPad;
  const area = `${line} L ${points.at(-1)[0]} ${baseline} L ${points[0][0]} ${baseline} Z`;
  const grid = [0.25, 0.5, 0.75]
    .map((pct) => {
      const y = pad + (height - pad - bottomPad) * pct;
      return `<line class="axis" x1="${pad}" x2="${width - pad}" y1="${y}" y2="${y}" />`;
    })
    .join("");
  const dateGuides = options.showDateGuides ? renderDateGuides(series, points, baseline) : "";
  const point = series.length === 1 ? `<circle class="chart-point" cx="${points[0][0]}" cy="${points[0][1]}" r="4" fill="${color}"></circle>` : "";
  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfica de ganancias">
      ${grid}
      ${dateGuides}
      <path class="area" d="${area}" fill="${color}"></path>
      <path class="line" d="${line}" stroke="${color}"></path>
      ${point}
    </svg>
  `;
}

function renderDateGuides(series, points, baseline) {
  const maxGuides = 9;
  const step = Math.max(1, Math.ceil(series.length / maxGuides));
  const indexes = [];
  for (let index = 0; index < series.length; index += step) indexes.push(index);
  if (indexes.at(-1) !== series.length - 1) indexes.push(series.length - 1);

  return indexes
    .map((index) => {
      const [x] = points[index];
      const label = formatChartDate(series[index].date);
      return `
        <line class="chart-date-guide" x1="${x}" x2="${x}" y1="16" y2="${baseline}"></line>
        <text class="chart-date-label" x="${x}" y="${baseline + 17}" text-anchor="middle">${label}</text>
      `;
    })
    .join("");
}

function formatChartDate(value) {
  const date = parseLocalDate(value);
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function renderForecast() {
  const rows = loadRows();
  const series = dailySeries(rows);
  const data = metrics(series);
  const average = data.average;
  const values = series.map((item) => item.value);
  const volatility = values.length > 1 ? standardDeviation(values) : 0;
  const conservative = Math.max(0, average - volatility * 0.5);
  const optimistic = average + volatility * 0.5;

  $("#forecastGrid").innerHTML = series.length
    ? `
      <article class="forecast-card feature">
        <p class="eyebrow">Lectura creativa</p>
        <strong>Si el ritmo actual se mantiene</strong>
        <div class="forecast-value">${money.format(average)} / día</div>
        <p>Tu ritmo combinado sugiere un rango diario entre ${money.format(conservative)} y ${money.format(optimistic)} cuando se considera la variación histórica reciente.</p>
      </article>
      ${forecastCard("Semana", average * 7, conservative * 7, optimistic * 7)}
      ${forecastCard("Mes", average * 30, conservative * 30, optimistic * 30)}
      ${forecastCard("Año", average * 365, conservative * 365, optimistic * 365)}
      <article class="forecast-card">
        <strong>Señal operativa</strong>
        <p>${forecastSignal(series)}</p>
      </article>
    `
    : `<div class="empty-state">Cuando tengas capturas, aquí aparecerán proyecciones semanales, mensuales y anuales.</div>`;
}

function forecastCard(title, expected, low, high) {
  return `
    <article class="forecast-card">
      <strong>${title}</strong>
      <div class="forecast-value">${money.format(expected)}</div>
      <p>Rango esperado: ${money.format(low)} a ${money.format(high)}.</p>
    </article>
  `;
}

function standardDeviation(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function forecastSignal(series) {
  const recent = series.slice(-7).map((item) => item.value);
  const prior = series.slice(-14, -7).map((item) => item.value);
  if (recent.length < 3 || prior.length < 3) return "Aún faltan más días para detectar tendencia, pero ya puedes usar el promedio como escenario base.";
  const recentAvg = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const priorAvg = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  if (recentAvg > priorAvg) return "La última ventana viene creciendo contra la anterior; el forecast alto es alcanzable si no hay modificaciones de pools.";
  if (recentAvg < priorAvg) return "La última ventana viene por debajo de la anterior; conviene revisar cambios de pool o variación operativa antes de asumir el escenario anual.";
  return "La última ventana está estable; el promedio actual es una base razonable para planear.";
}

function renderDatabase() {
  const rows = loadRows();
  $("#recordCount").textContent = `${rows.length} registros`;
  $("#currentUserName").textContent = currentUser?.username || "--";
  renderHistoryTable(rows);
}

function renderHistoryTable(rows) {
  const sorted = sortRows(rows).reverse();
  $("#historyTable").innerHTML = sorted.length
    ? `
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Pool</th>
            <th>Acumulado visible</th>
            <th>Ganancia día</th>
            <th>Acum. ajustado</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${sorted
            .map(
              (row) => `
                <tr data-row-id="${row.id}">
                  <td><input name="editDate" type="date" value="${escapeHtml(row.date)}" /></td>
                  <td><input name="editPool" value="${escapeHtml(row.pool)}" /></td>
                  <td><input name="editTotal" type="number" step="0.01" min="0" value="${row.total}" /></td>
                  <td>${money.format(row.daily)}</td>
                  <td>${money.format(row.adjustedTotal ?? row.total)}</td>
                  <td><span class="${row.modified ? "reset-tag" : "muted"}">${row.modified ? "Modificado" : "Normal"}</span></td>
                  <td>
                    <div class="table-actions">
                      <button class="small-button" type="button" data-save-row>Guardar</button>
                      <button class="small-button danger" type="button" data-delete-row>Borrar</button>
                    </div>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `
    : `<div class="empty-state">Todavía no hay capturas para este usuario.</div>`;
}

function showSection(sectionId, updateHash = true) {
  const safeSectionId = sections.includes(sectionId) ? sectionId : "capture";
  document.querySelectorAll(".page-section").forEach((section) => {
    section.classList.toggle("active", section.id === safeSectionId);
  });
  document.querySelectorAll("[data-section-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.sectionLink === safeSectionId);
  });
  if (updateHash && location.hash !== `#${safeSectionId}`) {
    history.pushState(null, "", `#${safeSectionId}`);
  }
}

function renderAll() {
  $("#todayText").textContent = dateLabel.format(new Date(`${todayISO()}T00:00:00`));
  renderPoolInputs();
  renderCapture();
  renderStats();
  renderForecast();
  renderDatabase();
}

async function upsertRows(incomingRows, source = "manual") {
  const data = await api("/api/rows", {
    method: "POST",
    body: JSON.stringify({ rows: incomingRows, source })
  });
  rowsCache = data.rows || [];
}

function rowsToCsv(rows) {
  const body = sortRows(rows).map((row) => [row.date, row.pool, row.total].map(csvCell).join(","));
  return ["date,pool,total", ...body].join("\n");
}

function rowsToBackupCsv(rows) {
  const body = sortRows(rows).map((row) =>
    [currentUser?.username, row.date, row.pool, row.total, row.daily, row.adjustedTotal ?? row.total, row.modified ? "yes" : "no"].map(csvCell).join(",")
  );
  return ["user,date,pool,total,daily,adjusted_total,modified", ...body].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function templateCsv() {
  const pools = defaultPools().length ? defaultPools() : ["rojo", "negro"];
  const lines = ["date,pool,total"];
  for (const [index, pool] of pools.entries()) {
    lines.push(`${todayISO()},${csvCell(pool)},${index === 0 ? "1000" : "850"}`);
  }
  return lines.join("\n");
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function parseCsv(text) {
  const cleanText = String(text || "").replace(/^\uFEFF/, "").replace(/^sep=.\r?\n/i, "");
  const delimiter = detectDelimiter(cleanText);
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;

  for (let i = 0; i < cleanText.length; i += 1) {
    const char = cleanText[i];
    const next = cleanText[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => item.trim())) rows.push(row);

  const [headers, ...data] = rows;
  if (!headers) throw new Error("El archivo esta vacio.");

  const normalized = headers.map(normalizeHeader);
  const dateIndex = findHeader(normalized, ["date", "fecha"]);
  const poolIndex = findHeader(normalized, ["pool", "piscina"]);
  const totalIndex = findHeader(normalized, ["total", "acumulado", "ganancia acumulada", "visible total", "visible_total"]);
  if ([dateIndex, poolIndex, totalIndex].includes(-1)) {
    throw new Error("No encontre columnas validas. Usa date,pool,total o fecha,pool,acumulado.");
  }

  return data.map((items) => ({
    date: normalizeDate(items[dateIndex]),
    pool: normalizePoolName(items[poolIndex]),
    total: normalizeNumber(items[totalIndex])
  }));
}

function detectDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
  const delimiters = [",", ";", "\t"];
  return delimiters
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0].delimiter;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function findHeader(headers, candidates) {
  return headers.findIndex((header) => candidates.includes(header));
}

function normalizeDate(value) {
  const cleanValue = String(value || "").trim();
  const iso = cleanValue.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const latam = cleanValue.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (latam) return `${latam[3]}-${latam[2].padStart(2, "0")}-${latam[1].padStart(2, "0")}`;
  return cleanValue;
}

function normalizeNumber(value) {
  const cleanValue = String(value || "")
    .trim()
    .replace(/\$/g, "")
    .replace(/\s/g, "");

  if (cleanValue.includes(",") && cleanValue.includes(".")) {
    return Number(cleanValue.replace(/,/g, ""));
  }
  if (cleanValue.includes(",") && !cleanValue.includes(".")) {
    return Number(cleanValue.replace(",", "."));
  }
  return Number(cleanValue);
}

function previewImport(rows, sourceLabel) {
  const valid = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.pool && Number.isFinite(row.total));
  const existingKeys = new Set(loadRows().map((row) => `${row.date}__${row.pool}`));
  const replaceCount = valid.filter((row) => existingKeys.has(`${row.date}__${row.pool}`)).length;
  const newCount = valid.length - replaceCount;
  const errorCount = rows.length - valid.length;
  pendingImportRows = valid;
  $("#uploadResult").textContent = `Previsualizacion de ${sourceLabel}: ${newCount} nuevos, ${replaceCount} reemplazos, ${errorCount} con error. Confirma para guardar.`;
  $("#importPreview").classList.toggle("auth-hidden", !valid.length);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showLogin(message = "Ingresa tus credenciales.") {
  $("#loginScreen").classList.remove("auth-hidden");
  $("#appShell").classList.add("auth-hidden");
  $("#loginError").textContent = message;
}

async function showApp() {
  $("#loginScreen").classList.add("auth-hidden");
  $("#appShell").classList.remove("auth-hidden");
  $("#currentUserName").textContent = currentUser?.username || "--";
  await refreshRows();
  showSection(location.hash.slice(1) || "capture", false);
}

$("#captureDate").value = todayISO();

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("#loginUser").value,
        password: $("#loginPassword").value
      })
    });
    currentUser = data.user;
    $("#loginPassword").value = "";
    await showApp();
  } catch (error) {
    showLogin(error.message);
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  currentUser = null;
  rowsCache = [];
  showLogin("Sesión cerrada.");
});

$("#addPoolButton").addEventListener("click", () => {
  const poolName = normalizePoolName(prompt("Nombre del nuevo pool"));
  if (!poolName) return;
  const container = $("#poolInputs");
  const existingPools = [...container.querySelectorAll('input[name="pool"]')].map((input) => normalizePoolName(input.value));
  if (existingPools.includes(poolName)) {
    alert("Ese pool ya existe en la captura.");
    return;
  }
  container.insertAdjacentHTML("beforeend", renderPoolInputRow(poolName, "", existingPools.length));
});

$("#poolInputs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-pool]");
  if (!button) return;
  button.closest(".pool-input-row").remove();
});

$("#captureDate").addEventListener("change", renderCapture);

$("#captureForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const rows = [...$("#poolInputs").querySelectorAll(".pool-input-row")].map((row) => ({
    date: $("#captureDate").value,
    pool: normalizePoolName(row.querySelector('[name="pool"]').value),
    total: Number(row.querySelector('[name="total"]').value)
  }));
  await upsertRows(rows, "manual");
  $("#captureStatus").textContent = "Captura manual guardada.";
  renderAll();
});

document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => {
    activeRange = button.dataset.range;
    document.querySelectorAll("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
    renderStats();
  });
});

document.querySelectorAll("[data-section-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showSection(link.dataset.sectionLink);
  });
});

window.addEventListener("hashchange", () => {
  showSection(location.hash.slice(1), false);
});

$("#downloadCsv").addEventListener("click", () => {
  downloadFile(`pool-gains-${currentUser?.username}.csv`, rowsToCsv(loadRows()));
});

$("#downloadBackup").addEventListener("click", () => {
  downloadFile(`pool-gains-backup-${currentUser?.username}.csv`, rowsToBackupCsv(loadRows()));
});

$("#downloadTemplate").addEventListener("click", () => {
  downloadFile(`plantilla-pool-gains-${currentUser?.username}.csv`, `\uFEFFsep=,\n${templateCsv()}\n`);
});

$("#csvUpload").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const rows = parseCsv(await file.text());
    previewImport(rows, file.name);
  } catch (error) {
    $("#uploadResult").textContent = error.message;
    $("#importPreview").classList.add("auth-hidden");
    pendingImportRows = [];
  } finally {
    event.target.value = "";
  }
});

$("#fillCsvExample").addEventListener("click", () => {
  $("#csvPasteBox").value = templateCsv();
  $("#uploadResult").textContent = "Ejemplo listo. Puedes editarlo y luego previsualizar.";
});

$("#previewPastedCsv").addEventListener("click", () => {
  try {
    const text = $("#csvPasteBox").value;
    if (!text.trim()) {
      $("#uploadResult").textContent = "Pega o escribe datos antes de previsualizar.";
      return;
    }
    previewImport(parseCsv(text), "texto pegado");
  } catch (error) {
    $("#uploadResult").textContent = error.message;
    $("#importPreview").classList.add("auth-hidden");
    pendingImportRows = [];
  }
});

$("#confirmImport").addEventListener("click", async () => {
  if (!pendingImportRows.length) return;
  await upsertRows(pendingImportRows, "csv_import");
  $("#uploadResult").textContent = `Importados ${pendingImportRows.length} registros.`;
  pendingImportRows = [];
  $("#importPreview").classList.add("auth-hidden");
  renderAll();
});

$("#cancelImport").addEventListener("click", () => {
  pendingImportRows = [];
  $("#uploadResult").textContent = "Importación cancelada.";
  $("#importPreview").classList.add("auth-hidden");
});

$("#historyTable").addEventListener("click", async (event) => {
  const rowElement = event.target.closest("tr[data-row-id]");
  if (!rowElement) return;
  const id = rowElement.dataset.rowId;

  if (event.target.closest("[data-delete-row]")) {
    if (!confirm("¿Borrar esta captura?")) return;
    const data = await api(`/api/rows/${id}`, { method: "DELETE" });
    rowsCache = data.rows || [];
    renderAll();
    return;
  }

  if (event.target.closest("[data-save-row]")) {
    try {
      const data = await api(`/api/rows/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          date: rowElement.querySelector('[name="editDate"]').value,
          pool: normalizePoolName(rowElement.querySelector('[name="editPool"]').value),
          total: Number(rowElement.querySelector('[name="editTotal"]').value)
        })
      });
      rowsCache = data.rows || [];
      $("#uploadResult").textContent = "Captura actualizada y métricas recalculadas.";
      renderAll();
    } catch (error) {
      $("#uploadResult").textContent = error.message;
    }
  }
});

async function bootstrap() {
  $("#todayText").textContent = dateLabel.format(new Date(`${todayISO()}T00:00:00`));
  try {
    const data = await api("/api/session");
    currentUser = data.user;
    if (currentUser) {
      await showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin("No se pudo conectar con el servidor.");
  }
}

bootstrap();
