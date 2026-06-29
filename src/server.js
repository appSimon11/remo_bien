import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ ||= process.env.APP_TIME_ZONE || "America/Mexico_City";

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appVersion = "remo2-mysql-v8-users-import";
const mysqlUrl = process.env.MYSQL_URL;
const cookieName = "remo2_session";
const cookieMaxAgeMs = 1000 * 60 * 60 * 24 * 30;

const pool = mysqlUrl
  ? mysql.createPool({
      uri: mysqlUrl,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
    })
  : null;

let databaseReady = false;
let lastDatabaseError = "";

app.use(express.json({ limit: "4mb" }));
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders(response, filePath) {
      if (/\.(html|css|js)$/.test(filePath)) response.setHeader("Cache-Control", "no-store");
    },
  }),
);

function toIsoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  return next;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function addYears(date, years) {
  return new Date(date.getFullYear() + years, 0, 1);
}

function currentYear() {
  return new Date().getFullYear();
}

function dayOfYear365(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 1);
  const elapsed = Math.floor((date - start) / 86400000) + 1;
  return Math.min(Math.max(elapsed, 1), 365);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function goalProbabilityFromHistory(historyRows, requiredDailyKilometers, remainingKilometers) {
  if (remainingKilometers <= 0) {
    return {
      available: true,
      percent: 100,
      historicalYears: historyRows.length,
      historicalDailyAverage: average(historyRows.map((row) => Number(row.kilometers || 0) / 365)),
      message: "Meta ya cumplida con el avance actual.",
    };
  }

  const dailyAverages = historyRows
    .map((row) => Number(row.kilometers || 0) / 365)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (dailyAverages.length === 0 || requiredDailyKilometers <= 0) {
    return {
      available: false,
      percent: 0,
      historicalYears: dailyAverages.length,
      historicalDailyAverage: 0,
      message: "Guarda al menos un año histórico para estimar la probabilidad.",
    };
  }

  const historicalDailyAverage = average(dailyAverages);
  const deviation = Math.max(standardDeviation(dailyAverages), historicalDailyAverage * 0.18, 0.01);
  const zScore = (historicalDailyAverage - requiredDailyKilometers) / deviation;
  const percent = Math.max(1, Math.min(99, 100 / (1 + Math.exp(-zScore))));
  const message =
    requiredDailyKilometers <= historicalDailyAverage
      ? "El ritmo necesario está dentro o por debajo de tu promedio histórico."
      : "El ritmo necesario está por arriba de tu promedio histórico.";

  return {
    available: true,
    percent,
    historicalYears: dailyAverages.length,
    historicalDailyAverage,
    message,
  };
}

function getRange(period, offset) {
  const today = new Date();
  const numericOffset = Number.parseInt(offset || "0", 10) || 0;

  if (period === "day") {
    const start = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), numericOffset);
    return { start, end: addDays(start, 1), bucket: "session" };
  }
  if (period === "week") {
    const start = addDays(startOfWeek(today), numericOffset * 7);
    return { start, end: addDays(start, 7), bucket: "day" };
  }
  if (period === "month") {
    const start = addMonths(startOfMonth(today), numericOffset);
    return { start, end: addMonths(start, 1), bucket: "day" };
  }
  if (period === "year") {
    const start = addYears(startOfYear(today), numericOffset);
    return { start, end: addYears(start, 1), bucket: "month" };
  }
  return null;
}

function rangeTitle(period, start, end) {
  const dayFormatter = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" });
  const monthFormatter = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" });
  if (period === "day") return dayFormatter.format(start);
  if (period === "week") return `${dayFormatter.format(start)} - ${dayFormatter.format(addDays(end, -1))}`;
  if (period === "month") return monthFormatter.format(start);
  return String(start.getFullYear());
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passwordHash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return { salt, passwordHash };
}

function verifyPassword(password, salt, passwordHash) {
  const actual = hashPassword(password, salt).passwordHash;
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(passwordHash, "hex"));
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(cookieMaxAgeMs / 1000)}${secure}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

async function columnExists(tableName, columnName) {
  const [columns] = await pool.execute(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    [tableName, columnName],
  );
  return columns.length > 0;
}

async function addColumnIfMissing(tableName, columnName, definition) {
  if (!(await columnExists(tableName, columnName))) {
    await pool.execute(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

async function ensureUniqueIndex(tableName, indexName, definition) {
  const [indexes] = await pool.execute(
    `
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
    `,
    [tableName, indexName],
  );
  if (indexes.length === 0) await pool.execute(`ALTER TABLE ${tableName} ADD ${definition}`);
}

async function dropPrimaryKeyIfPresent(tableName) {
  const [constraints] = await pool.execute(
    `
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_TYPE = 'PRIMARY KEY'
    `,
    [tableName],
  );
  if (constraints.length > 0) await pool.execute(`ALTER TABLE ${tableName} DROP PRIMARY KEY`);
}

async function getDefaultUserId() {
  const { salt, passwordHash } = hashPassword("a");
  await pool.execute(
    `
      INSERT INTO users (username, password_salt, password_hash)
      VALUES ('a', ?, ?)
      ON DUPLICATE KEY UPDATE username = username
    `,
    [salt, passwordHash],
  );
  const [[user]] = await pool.execute("SELECT id FROM users WHERE username = 'a'");
  return user.id;
}

async function initializeDatabase() {
  if (!pool) throw new Error("Falta configurar MYSQL_URL en Railway.");

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      password_salt VARCHAR(64) NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const defaultUserId = await getDefaultUserId();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rowing_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      session_date DATE NOT NULL,
      kilometers DECIMAL(8, 2) NOT NULL,
      strokes INT NOT NULL,
      calories DECIMAL(8, 2) NOT NULL DEFAULT 0,
      duration_minutes INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (kilometers >= 0),
      CHECK (strokes >= 0),
      CHECK (calories >= 0),
      CHECK (duration_minutes >= 0)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS historical_years (
      user_id INT NULL,
      year INT NOT NULL,
      kilometers DECIMAL(10, 2) NOT NULL DEFAULT 0,
      duration_minutes INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CHECK (kilometers >= 0),
      CHECK (duration_minutes >= 0)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS current_year_baselines (
      user_id INT NULL,
      year INT NOT NULL,
      seed_date DATE NOT NULL,
      initial_kilometers DECIMAL(10, 2) NOT NULL DEFAULT 0,
      initial_duration_minutes INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CHECK (initial_kilometers >= 0),
      CHECK (initial_duration_minutes >= 0)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await addColumnIfMissing("rowing_sessions", "user_id", "user_id INT NULL");
  await addColumnIfMissing("rowing_sessions", "calories", "calories DECIMAL(8, 2) NOT NULL DEFAULT 0");
  await addColumnIfMissing("rowing_sessions", "duration_minutes", "duration_minutes INT NOT NULL DEFAULT 0");
  await addColumnIfMissing("historical_years", "user_id", "user_id INT NULL");
  await addColumnIfMissing("current_year_baselines", "user_id", "user_id INT NULL");
  await pool.execute("UPDATE rowing_sessions SET user_id = ? WHERE user_id IS NULL", [defaultUserId]);
  await pool.execute("UPDATE historical_years SET user_id = ? WHERE user_id IS NULL", [defaultUserId]);
  await pool.execute("UPDATE current_year_baselines SET user_id = ? WHERE user_id IS NULL", [defaultUserId]);
  await ensureUniqueIndex("rowing_sessions", "idx_rowing_sessions_user_date", "INDEX idx_rowing_sessions_user_date (user_id, session_date)");
  await dropPrimaryKeyIfPresent("historical_years");
  await dropPrimaryKeyIfPresent("current_year_baselines");
  await ensureUniqueIndex("historical_years", "uniq_history_user_year", "UNIQUE KEY uniq_history_user_year (user_id, year)");
  await ensureUniqueIndex(
    "current_year_baselines",
    "uniq_baseline_user_year",
    "UNIQUE KEY uniq_baseline_user_year (user_id, year)",
  );

  databaseReady = true;
  lastDatabaseError = "";
}

async function requireDatabase(_request, response, next) {
  if (!pool) return response.status(503).json({ message: "Falta configurar MYSQL_URL en Railway." });
  if (!databaseReady) {
    try {
      await initializeDatabase();
    } catch (error) {
      databaseReady = false;
      lastDatabaseError = error.message;
      return response.status(503).json({
        message: "La base de datos MySQL todavía no está conectada.",
        detail: lastDatabaseError,
      });
    }
  }
  next();
}

async function requireAuth(request, response, next) {
  const token = parseCookies(request.headers.cookie)[cookieName];
  if (!token) return response.status(401).json({ message: "Inicia sesión para continuar." });

  const [[session]] = await pool.execute(
    `
      SELECT auth_sessions.user_id AS id, users.username
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE token_hash = ? AND expires_at > NOW()
    `,
    [sha256(token)],
  );

  if (!session) {
    clearSessionCookie(response);
    return response.status(401).json({ message: "Tu sesión expiró. Vuelve a entrar." });
  }

  request.user = session;
  next();
}

function validateSessionPayload(body) {
  const km = Number(body.kilometers);
  const totalStrokes = Number.parseInt(body.strokes, 10);
  const totalCalories = Number(body.calories);
  const totalMinutes = Number.parseInt(body.durationMinutes, 10);
  const date = body.sessionDate || toIsoDate(new Date());

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Captura una fecha válida." };
  if (!Number.isFinite(km) || km <= 0) return { error: "Captura kilómetros mayores a 0." };
  if (!Number.isInteger(totalStrokes) || totalStrokes <= 0) return { error: "Captura paladas mayores a 0." };
  if (!Number.isFinite(totalCalories) || totalCalories <= 0) return { error: "Captura calorías mayores a 0." };
  if (!Number.isInteger(totalMinutes) || totalMinutes <= 0) return { error: "Captura tiempo mayor a 0 minutos." };

  return {
    row: {
      sessionDate: date,
      kilometers: km,
      strokes: totalStrokes,
      calories: totalCalories,
      durationMinutes: totalMinutes,
    },
  };
}

function sessionSelectSql(where) {
  return `
    SELECT
      id,
      DATE_FORMAT(session_date, '%Y-%m-%d') AS sessionDate,
      CAST(kilometers AS DOUBLE) AS kilometers,
      strokes,
      CAST(calories AS DOUBLE) AS calories,
      duration_minutes AS durationMinutes,
      CASE WHEN duration_minutes > 0 THEN CAST(kilometers AS DOUBLE) / (duration_minutes / 60) ELSE 0 END AS averageSpeed,
      CASE WHEN kilometers > 0 THEN duration_minutes / kilometers / 2 ELSE 0 END AS pace500m,
      CASE WHEN duration_minutes > 0 THEN strokes / duration_minutes ELSE 0 END AS strokesPerMinute,
      CASE WHEN kilometers > 0 THEN CAST(calories AS DOUBLE) / CAST(kilometers AS DOUBLE) ELSE 0 END AS caloriesPerKm,
      created_at
    FROM rowing_sessions
    ${where}
  `;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(field.trim());
      field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function previewImport(text) {
  const rows = parseCsv(text);
  const header = rows.shift()?.map((item) => item.toLowerCase().trim()) || [];
  const aliases = {
    sessionDate: ["fecha", "dia", "día", "sessiondate", "session_date"],
    kilometers: ["kilometros", "kilómetros", "km", "kilometers"],
    strokes: ["paladas", "strokes"],
    calories: ["calorias", "calorías", "calories"],
    durationMinutes: ["tiempo", "minutos", "durationminutes", "duration_minutes"],
  };
  const positions = Object.fromEntries(
    Object.entries(aliases).map(([key, names]) => [key, header.findIndex((item) => names.includes(item))]),
  );

  const missing = Object.entries(positions)
    .filter(([, position]) => position < 0)
    .map(([key]) => key);

  if (missing.length > 0) {
    return {
      validRows: [],
      errors: [`Faltan columnas: ${missing.join(", ")}.`],
      totalRows: rows.length,
    };
  }

  const validRows = [];
  const errors = [];
  rows.forEach((source, index) => {
    const result = validateSessionPayload({
      sessionDate: source[positions.sessionDate],
      kilometers: source[positions.kilometers],
      strokes: source[positions.strokes],
      calories: source[positions.calories],
      durationMinutes: source[positions.durationMinutes],
    });
    if (result.error) errors.push(`Fila ${index + 2}: ${result.error}`);
    else validRows.push(result.row);
  });

  return { validRows, errors, totalRows: rows.length };
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    appVersion,
    databaseType: "mysql",
    hasMysqlUrl: Boolean(mysqlUrl),
    databaseReady,
    lastDatabaseError,
    timeZone: process.env.TZ,
  });
});

app.get("/api/auth/me", requireDatabase, async (request, response) => {
  const token = parseCookies(request.headers.cookie)[cookieName];
  if (!token) return response.json({ authenticated: false });
  const [[session]] = await pool.execute(
    `
      SELECT users.id, users.username
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE token_hash = ? AND expires_at > NOW()
    `,
    [sha256(token)],
  );
  response.json(session ? { authenticated: true, user: session } : { authenticated: false });
});

app.post("/api/auth/login", requireDatabase, async (request, response) => {
  const username = String(request.body.username || "").trim();
  const password = String(request.body.password || "");
  const [[user]] = await pool.execute("SELECT * FROM users WHERE username = ?", [username]);

  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return response.status(401).json({ message: "Usuario o contraseña incorrectos." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  await pool.execute("INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))", [
    user.id,
    sha256(token),
  ]);
  setSessionCookie(response, token);
  response.json({ user: { id: user.id, username: user.username } });
});

app.post("/api/auth/register", requireDatabase, async (request, response, next) => {
  try {
    const username = String(request.body.username || "").trim();
    const password = String(request.body.password || "");
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(username)) {
      return response.status(400).json({ message: "Usa un usuario corto con letras, números, punto, guion o guion bajo." });
    }
    if (password.length < 1) return response.status(400).json({ message: "Captura una contraseña." });

    const { salt, passwordHash } = hashPassword(password);
    await pool.execute("INSERT INTO users (username, password_salt, password_hash) VALUES (?, ?, ?)", [
      username,
      salt,
      passwordHash,
    ]);
    response.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return response.status(409).json({ message: "Ese usuario ya existe." });
    next(error);
  }
});

app.post("/api/auth/logout", requireDatabase, async (request, response) => {
  const token = parseCookies(request.headers.cookie)[cookieName];
  if (token) await pool.execute("DELETE FROM auth_sessions WHERE token_hash = ?", [sha256(token)]);
  clearSessionCookie(response);
  response.json({ ok: true });
});

app.get("/api/sessions", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const limit = Math.min(Number.parseInt(request.query.limit || "80", 10) || 80, 300);
    const [rows] = await pool.execute(
      `${sessionSelectSql("WHERE user_id = ?")} ORDER BY session_date DESC, created_at DESC LIMIT ${limit}`,
      [request.user.id],
    );
    response.json(rows.map((row) => ({ ...row, averageSpeed: Number(row.averageSpeed || 0) })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const result = validateSessionPayload(request.body);
    if (result.error) return response.status(400).json({ message: result.error });
    const row = result.row;
    const [insert] = await pool.execute(
      `
        INSERT INTO rowing_sessions (user_id, session_date, kilometers, strokes, calories, duration_minutes)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [request.user.id, row.sessionDate, row.kilometers, row.strokes, row.calories, row.durationMinutes],
    );
    const [[created]] = await pool.execute(`${sessionSelectSql("WHERE id = ? AND user_id = ?")}`, [insert.insertId, request.user.id]);
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.put("/api/sessions/:id", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const result = validateSessionPayload(request.body);
    if (result.error) return response.status(400).json({ message: result.error });
    const row = result.row;
    const [update] = await pool.execute(
      `
        UPDATE rowing_sessions
        SET session_date = ?, kilometers = ?, strokes = ?, calories = ?, duration_minutes = ?
        WHERE id = ? AND user_id = ?
      `,
      [row.sessionDate, row.kilometers, row.strokes, row.calories, row.durationMinutes, request.params.id, request.user.id],
    );
    if (update.affectedRows === 0) return response.status(404).json({ message: "No encontré esa sesión." });
    const [[updated]] = await pool.execute(`${sessionSelectSql("WHERE id = ? AND user_id = ?")}`, [request.params.id, request.user.id]);
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions/:id", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const [deleted] = await pool.execute("DELETE FROM rowing_sessions WHERE id = ? AND user_id = ?", [
      request.params.id,
      request.user.id,
    ]);
    if (deleted.affectedRows === 0) return response.status(404).json({ message: "No encontré esa sesión." });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/export.csv", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const [rows] = await pool.execute(`${sessionSelectSql("WHERE user_id = ?")} ORDER BY session_date ASC, created_at ASC`, [
      request.user.id,
    ]);
    const header = ["fecha", "kilometros", "paladas", "calorias", "tiempo_minutos"];
    const lines = rows.map((row) =>
      [row.sessionDate, row.kilometers, row.strokes, row.calories, row.durationMinutes].map(csvEscape).join(","),
    );
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="remo2-sesiones-${request.user.username}.csv"`);
    response.send([header.join(","), ...lines].join("\n"));
  } catch (error) {
    next(error);
  }
});

app.get("/api/import-template.csv", requireDatabase, requireAuth, (_request, response) => {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", 'attachment; filename="plantilla-remo2.csv"');
  response.send("fecha,kilometros,paladas,calorias,tiempo_minutos\n2026-01-15,8.4,6420,320,42\n");
});

app.post("/api/import-preview", requireDatabase, requireAuth, (request, response) => {
  response.json(previewImport(String(request.body.text || "")));
});

app.post("/api/import-sessions", requireDatabase, requireAuth, async (request, response, next) => {
  const connection = await pool.getConnection();
  try {
    const rows = Array.isArray(request.body.rows) ? request.body.rows : [];
    const checked = rows.map((row) => validateSessionPayload(row));
    const errors = checked.map((item, index) => (item.error ? `Fila ${index + 1}: ${item.error}` : "")).filter(Boolean);
    if (errors.length > 0) return response.status(400).json({ message: "Hay filas inválidas.", errors });
    await connection.beginTransaction();
    for (const item of checked) {
      const row = item.row;
      await connection.execute(
        `
          INSERT INTO rowing_sessions (user_id, session_date, kilometers, strokes, calories, duration_minutes)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [request.user.id, row.sessionDate, row.kilometers, row.strokes, row.calories, row.durationMinutes],
      );
    }
    await connection.commit();
    response.status(201).json({ ok: true, imported: checked.length });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

app.get("/api/stats", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const period = request.query.period || "week";
    const range = getRange(period, request.query.offset);
    if (!range) return response.status(400).json({ message: "Periodo no válido." });

    const start = toIsoDate(range.start);
    const end = toIsoDate(range.end);
    const [[summaryRow]] = await pool.execute(
      `
        SELECT
          COUNT(*) AS sessions,
          COALESCE(SUM(kilometers), 0) AS kilometers,
          COALESCE(SUM(strokes), 0) AS strokes,
          COALESCE(SUM(calories), 0) AS calories,
          COALESCE(SUM(duration_minutes), 0) AS durationMinutes
        FROM rowing_sessions
        WHERE user_id = ? AND session_date >= ? AND session_date < ?
      `,
      [request.user.id, start, end],
    );

    const bucketSql =
      range.bucket === "month"
        ? "DATE_FORMAT(session_date, '%Y-%m')"
        : range.bucket === "session"
          ? "CONCAT(DATE_FORMAT(created_at, '%H:%i'), ' #', id)"
          : "DATE_FORMAT(session_date, '%Y-%m-%d')";

    const [chartRows] = await pool.execute(
      `
        SELECT
          ${bucketSql} AS label,
          COALESCE(SUM(kilometers), 0) AS kilometers,
          COALESCE(SUM(strokes), 0) AS strokes,
          COALESCE(SUM(calories), 0) AS calories,
          COALESCE(SUM(duration_minutes), 0) AS durationMinutes
        FROM rowing_sessions
        WHERE user_id = ? AND session_date >= ? AND session_date < ?
        GROUP BY label
        ORDER BY MIN(session_date), MIN(created_at)
      `,
      [request.user.id, start, end],
    );

    const row = summaryRow || {};
    const kilometers = Number(row.kilometers || 0);
    const durationMinutes = Number(row.durationMinutes || 0);
    const strokes = Number(row.strokes || 0);
    const calories = Number(row.calories || 0);
    response.json({
      period,
      range: { start, end, title: rangeTitle(period, range.start, range.end) },
      summary: {
        sessions: Number(row.sessions || 0),
        kilometers,
        strokes,
        calories,
        durationMinutes,
        averageSpeed: durationMinutes > 0 ? kilometers / (durationMinutes / 60) : 0,
        pace500m: kilometers > 0 ? durationMinutes / kilometers / 2 : 0,
        strokesPerMinute: durationMinutes > 0 ? strokes / durationMinutes : 0,
        caloriesPerKm: kilometers > 0 ? calories / kilometers : 0,
      },
      chart: chartRows.map((item) => ({
        label: item.label,
        kilometers: Number(item.kilometers || 0),
        strokes: Number(item.strokes || 0),
        calories: Number(item.calories || 0),
        durationMinutes: Number(item.durationMinutes || 0),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/history-years", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const [rows] = await pool.execute(
      `
        SELECT
          year,
          CAST(kilometers AS DOUBLE) AS kilometers,
          duration_minutes AS durationMinutes,
          CASE WHEN duration_minutes > 0 THEN CAST(kilometers AS DOUBLE) / (duration_minutes / 60) ELSE 0 END AS averageSpeed,
          CAST(kilometers AS DOUBLE) / 365 AS dailyAverage
        FROM historical_years
        WHERE user_id = ?
        ORDER BY year DESC
      `,
      [request.user.id],
    );
    response.json(rows.map((row) => ({ ...row, averageSpeed: Number(row.averageSpeed || 0), dailyAverage: Number(row.dailyAverage || 0) })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/history-years", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const year = Number.parseInt(request.body.year, 10);
    const kilometers = Number(request.body.kilometers);
    const durationMinutes = Number.parseInt(request.body.durationMinutes, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 3000) return response.status(400).json({ message: "Captura un año válido." });
    if (!Number.isFinite(kilometers) || kilometers < 0) return response.status(400).json({ message: "Captura kilómetros válidos." });
    if (!Number.isInteger(durationMinutes) || durationMinutes < 0) return response.status(400).json({ message: "Captura tiempo válido." });
    await pool.execute(
      `
        INSERT INTO historical_years (user_id, year, kilometers, duration_minutes)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE kilometers = VALUES(kilometers), duration_minutes = VALUES(duration_minutes)
      `,
      [request.user.id, year, kilometers, durationMinutes],
    );
    response.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

async function resetCurrentYear(request, response, next) {
  const connection = await pool.getConnection();
  try {
    const year = currentYear();
    const seedDate = request.body.seedDate || toIsoDate(new Date());
    const initialKilometers = Number(request.body.initialKilometers);
    const initialDurationMinutes = Number.parseInt(request.body.initialDurationMinutes, 10);
    const confirmationText = String(request.body.confirmationText || "");
    if (confirmationText !== "BORRAR") return response.status(400).json({ message: "Escribe BORRAR para confirmar." });
    if (!Number.isFinite(initialKilometers) || initialKilometers < 0) return response.status(400).json({ message: "Captura kilómetros iniciales válidos." });
    if (!Number.isInteger(initialDurationMinutes) || initialDurationMinutes < 0) return response.status(400).json({ message: "Captura tiempo inicial válido." });

    await connection.beginTransaction();
    const [deleted] = await connection.execute("DELETE FROM rowing_sessions WHERE user_id = ? AND YEAR(session_date) = ?", [
      request.user.id,
      year,
    ]);
    await connection.execute(
      `
        INSERT INTO current_year_baselines (user_id, year, seed_date, initial_kilometers, initial_duration_minutes)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          seed_date = VALUES(seed_date),
          initial_kilometers = VALUES(initial_kilometers),
          initial_duration_minutes = VALUES(initial_duration_minutes)
      `,
      [request.user.id, year, seedDate, initialKilometers, initialDurationMinutes],
    );
    await connection.commit();
    response.json({ ok: true, deletedSessions: deleted.affectedRows });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

app.get("/api/current-year-reset-info", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const [[row]] = await pool.execute("SELECT COUNT(*) AS sessions FROM rowing_sessions WHERE user_id = ? AND YEAR(session_date) = ?", [
      request.user.id,
      currentYear(),
    ]);
    response.json({ year: currentYear(), sessions: Number(row.sessions || 0), confirmationText: "BORRAR" });
  } catch (error) {
    next(error);
  }
});

app.put("/api/current-year-baseline", requireDatabase, requireAuth, resetCurrentYear);
app.post("/api/current-year-reset", requireDatabase, requireAuth, resetCurrentYear);

app.get("/api/forecast", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const year = currentYear();
    const previousYear = year - 1;
    const [[previous]] = await pool.execute(
      "SELECT CAST(kilometers AS DOUBLE) AS kilometers, duration_minutes AS durationMinutes FROM historical_years WHERE user_id = ? AND year = ?",
      [request.user.id, previousYear],
    );
    const [historyRows] = await pool.execute(
      "SELECT year, CAST(kilometers AS DOUBLE) AS kilometers FROM historical_years WHERE user_id = ? ORDER BY year ASC",
      [request.user.id],
    );
    const [[baseline]] = await pool.execute(
      `
        SELECT DATE_FORMAT(seed_date, '%Y-%m-%d') AS seedDate,
          CAST(initial_kilometers AS DOUBLE) AS initialKilometers,
          initial_duration_minutes AS initialDurationMinutes
        FROM current_year_baselines
        WHERE user_id = ? AND year = ?
      `,
      [request.user.id, year],
    );
    const [[current]] = await pool.execute(
      `
        SELECT COALESCE(SUM(kilometers), 0) AS kilometers, COALESCE(SUM(duration_minutes), 0) AS durationMinutes
        FROM rowing_sessions
        WHERE user_id = ? AND YEAR(session_date) = ?
      `,
      [request.user.id, year],
    );

    const previousKilometers = Number(previous?.kilometers || 0);
    const goalKilometers = previousKilometers * 1.05;
    const initialKilometers = Number(baseline?.initialKilometers || 0);
    const initialDurationMinutes = Number(baseline?.initialDurationMinutes || 0);
    const sessionKilometers = Number(current?.kilometers || 0);
    const sessionDurationMinutes = Number(current?.durationMinutes || 0);
    const totalKilometers = initialKilometers + sessionKilometers;
    const totalDurationMinutes = initialDurationMinutes + sessionDurationMinutes;
    const remainingKilometers = Math.max(goalKilometers - totalKilometers, 0);
    const daysElapsed = dayOfYear365();
    const daysRemaining = Math.max(365 - daysElapsed, 0);
    const requiredDailyKilometers = daysRemaining > 0 ? remainingKilometers / daysRemaining : remainingKilometers;
    const goalProbability = goalProbabilityFromHistory(historyRows, requiredDailyKilometers, remainingKilometers);

    response.json({
      year,
      previousYear,
      previous: { kilometers: previousKilometers, durationMinutes: Number(previous?.durationMinutes || 0) },
      baseline: {
        seedDate: baseline?.seedDate || toIsoDate(new Date()),
        initialKilometers,
        initialDurationMinutes,
      },
      current: { sessionKilometers, sessionDurationMinutes, totalKilometers, totalDurationMinutes },
      forecast: {
        goalKilometers,
        progressPercent: goalKilometers > 0 ? Math.min((totalKilometers / goalKilometers) * 100, 100) : 0,
        remainingKilometers,
        daysElapsed,
        daysRemaining,
        requiredDailyKilometers,
        dailyAverage: totalKilometers / 365,
        averageSpeed: totalDurationMinutes > 0 ? totalKilometers / (totalDurationMinutes / 60) : 0,
        goalProbability,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/year-map", requireDatabase, requireAuth, async (request, response, next) => {
  try {
    const year = currentYear();
    const today = new Date();
    const todayIndex = dayOfYear365(today);
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const [[baseline]] = await pool.execute(
      "SELECT DATE_FORMAT(seed_date, '%Y-%m-%d') AS seedDate FROM current_year_baselines WHERE user_id = ? AND year = ?",
      [request.user.id, year],
    );
    const [sessionRows] = await pool.execute(
      `
        SELECT DISTINCT DATE_FORMAT(session_date, '%Y-%m-%d') AS sessionDate
        FROM rowing_sessions
        WHERE user_id = ? AND session_date >= ? AND session_date < ?
      `,
      [request.user.id, toIsoDate(yearStart), toIsoDate(yearEnd)],
    );
    const sessionDates = new Set(sessionRows.map((row) => row.sessionDate));
    const seedIndex = baseline?.seedDate ? dayOfYear365(new Date(`${baseline.seedDate}T00:00:00`)) : 0;
    const days = [];
    for (let index = 1; index <= 365; index += 1) {
      const date = addDays(yearStart, index - 1);
      const isoDate = toIsoDate(date);
      const isBaselineCovered = seedIndex > 0 && index <= seedIndex;
      const hasSession = sessionDates.has(isoDate);
      const isPastOrToday = index <= todayIndex;
      days.push({ index, date: isoDate, status: isBaselineCovered || hasSession ? "done" : isPastOrToday ? "missed" : "future" });
    }
    response.json({ year, todayIndex, baselineSeedDate: baseline?.seedDate || null, days });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: "No se pudo completar la acción.", detail: error.message });
});

app.listen(port, () => {
  console.log(`Remo2 listo en http://localhost:${port}`);
  initializeDatabase().catch((error) => {
    databaseReady = false;
    lastDatabaseError = error.message;
    console.error("La app arrancó, pero MySQL no está listo:", error.message);
  });
});
