import "dotenv/config";
import express from "express";
import session from "express-session";
import mysql from "mysql2/promise";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(
  session({
    name: "pool.sid",
    secret: process.env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

const db = mysql.createPool(databaseConfig());

function databaseConfig() {
  const uri = process.env.MYSQL_URL || process.env.MYSQL_PRIVATE_URL || process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
  if (uri) {
    return {
      uri,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true
    };
  }

  return {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || "root",
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || "pool_console",
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true
  };
}

async function query(sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function columnExists(tableName, columnName) {
  const rows = await query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(tableName, columnName, definition) {
  if (!(await columnExists(tableName, columnName))) {
    await query(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

async function makeColumnNullableIfExists(tableName, columnName, definition) {
  if (await columnExists(tableName, columnName)) {
    await query(`ALTER TABLE ${tableName} MODIFY COLUMN ${definition}`);
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      password_plain VARCHAR(120) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS pools (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uniq_pool_user_name UNIQUE (user_id, name),
      CONSTRAINT fk_pools_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS captures (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      pool_id INT NOT NULL,
      capture_date DATE NOT NULL,
      visible_total DECIMAL(16, 2) NOT NULL,
      source ENUM('manual', 'csv_import') NOT NULL DEFAULT 'manual',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT uniq_capture_user_pool_date UNIQUE (user_id, pool_id, capture_date),
      CONSTRAINT fk_captures_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_captures_pool FOREIGN KEY (pool_id) REFERENCES pools(id) ON DELETE CASCADE
    )
  `);

  await addColumnIfMissing("users", "password_plain", "password_plain VARCHAR(120) NULL");
  await addColumnIfMissing("users", "created_at", "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await makeColumnNullableIfExists("users", "password_salt", "password_salt VARCHAR(64) NULL");
  await makeColumnNullableIfExists("users", "password_hash", "password_hash VARCHAR(128) NULL");
  await addColumnIfMissing("pools", "active", "active BOOLEAN NOT NULL DEFAULT TRUE");
  await addColumnIfMissing("pools", "created_at", "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("captures", "source", "source VARCHAR(20) NOT NULL DEFAULT 'manual'");
  await addColumnIfMissing("captures", "created_at", "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing(
    "captures",
    "updated_at",
    "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
  );

  await query(
    `
      INSERT INTO users (username, password_plain)
      VALUES ('Andres', 'Andres$'), ('Sandra', 'Sandra$')
      ON DUPLICATE KEY UPDATE password_plain = VALUES(password_plain)
    `
  );
  await ensurePoolRename("Andres", "97", "rojo");
  await ensurePoolRename("Andres", "09", "negro");
  await ensureDefaultPool("Sandra", "UNI");
}

async function ensureDefaultPool(username, poolName) {
  const [user] = await query("SELECT id FROM users WHERE username = ?", [username]);
  if (!user) return;
  await query(
    `
      INSERT INTO pools (user_id, name)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE active = TRUE
    `,
    [user.id, poolName]
  );
}

async function ensurePoolRename(username, oldName, newName) {
  const [user] = await query("SELECT id FROM users WHERE username = ?", [username]);
  if (!user) return;

  const [oldPool] = await query("SELECT id FROM pools WHERE user_id = ? AND name = ?", [user.id, oldName]);
  const [newPool] = await query("SELECT id FROM pools WHERE user_id = ? AND name = ?", [user.id, newName]);

  if (oldPool && !newPool) {
    await query("UPDATE pools SET name = ?, active = TRUE WHERE id = ?", [newName, oldPool.id]);
    return;
  }

  if (oldPool && newPool) {
    await query("UPDATE captures SET pool_id = ?, updated_at = CURRENT_TIMESTAMP WHERE pool_id = ?", [newPool.id, oldPool.id]);
    await query("DELETE FROM pools WHERE id = ?", [oldPool.id]);
    await query("UPDATE pools SET active = TRUE WHERE id = ?", [newPool.id]);
    return;
  }

  await ensureDefaultPool(username, newName);
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    res.status(401).json({ error: "No has iniciado sesión." });
    return;
  }
  next();
}

function normalizePoolName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function recalculate(rows) {
  const grouped = new Map();
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.pool.localeCompare(b.pool));

  for (const row of sorted) {
    const previous = grouped.get(row.pool)?.at(-1);
    const modified = Boolean(previous && row.total < previous.total);
    const daily = previous && !modified ? row.total - previous.total : row.total;
    const previousAdjusted = previous ? previous.adjustedTotal : 0;
    const enriched = {
      ...row,
      daily: round2(daily),
      adjustedTotal: round2(previousAdjusted + daily),
      modified
    };
    if (!grouped.has(row.pool)) grouped.set(row.pool, []);
    grouped.get(row.pool).push(enriched);
  }

  return [...grouped.values()].flat().sort((a, b) => a.date.localeCompare(b.date) || a.pool.localeCompare(b.pool));
}

async function getOrCreatePoolId(userId, name) {
  const poolName = normalizePoolName(name);
  const [existing] = await query("SELECT id FROM pools WHERE user_id = ? AND name = ?", [userId, poolName]);
  if (existing) return existing.id;

  const [result] = await db.execute("INSERT INTO pools (user_id, name) VALUES (?, ?)", [userId, poolName]);
  return result.insertId;
}

async function rowsForUser(userId) {
  const rows = await query(
    `
      SELECT
        c.id,
        DATE_FORMAT(c.capture_date, '%Y-%m-%d') AS date,
        p.name AS pool,
        CAST(c.visible_total AS DOUBLE) AS total,
        c.source,
        c.created_at,
        c.updated_at
      FROM captures c
      JOIN pools p ON p.id = c.pool_id
      WHERE c.user_id = ?
      ORDER BY c.capture_date ASC, p.name ASC
    `,
    [userId]
  );
  return recalculate(rows.map((row) => ({ ...row, total: Number(row.total) })));
}

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const [user] = await query("SELECT id, username, password_plain FROM users WHERE LOWER(username) = LOWER(?)", [username]);

  if (!user || user.password_plain !== password) {
    res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    return;
  }

  req.session.user = { id: user.id, username: user.username };
  res.json({ user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get("/api/rows", requireAuth, async (req, res) => {
  res.json({ rows: await rowsForUser(req.session.user.id) });
});

app.post("/api/rows", requireAuth, async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const source = req.body.source === "csv_import" ? "csv_import" : "manual";
  const validRows = rows
    .map((row) => ({
      date: String(row.date || "").slice(0, 10),
      pool: normalizePoolName(row.pool),
      total: Number(row.total)
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.pool && Number.isFinite(row.total));

  for (const row of validRows) {
    const poolId = await getOrCreatePoolId(req.session.user.id, row.pool);
    await query(
      `
        INSERT INTO captures (user_id, pool_id, capture_date, visible_total, source)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE visible_total = VALUES(visible_total), source = VALUES(source), updated_at = CURRENT_TIMESTAMP
      `,
      [req.session.user.id, poolId, row.date, row.total, source]
    );
  }

  res.json({ rows: await rowsForUser(req.session.user.id), imported: validRows.length });
});

app.put("/api/rows/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const date = String(req.body.date || "").slice(0, 10);
  const poolName = normalizePoolName(req.body.pool);
  const total = Number(req.body.total);

  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !poolName || !Number.isFinite(total)) {
    res.status(400).json({ error: "Fecha, pool o acumulado inválido." });
    return;
  }

  const poolId = await getOrCreatePoolId(req.session.user.id, poolName);
  await query(
    "UPDATE captures SET capture_date = ?, pool_id = ?, visible_total = ?, source = 'manual', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
    [date, poolId, total, id, req.session.user.id]
  );
  res.json({ rows: await rowsForUser(req.session.user.id) });
});

app.delete("/api/rows/:id", requireAuth, async (req, res) => {
  await query("DELETE FROM captures WHERE id = ? AND user_id = ?", [Number(req.params.id), req.session.user.id]);
  res.json({ rows: await rowsForUser(req.session.user.id) });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, database: "mysql" });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Pool Console MySQL listening on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
