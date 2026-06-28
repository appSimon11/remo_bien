import "dotenv/config";
import express from "express";
import session from "express-session";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
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

const db = new Pool(databaseConfig());

function databaseConfig() {
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_PUBLIC_URL || process.env.POSTGRES_URL;
  if (connectionString) {
    return {
      connectionString,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    };
  }

  return {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.PGUSER || process.env.POSTGRES_USER || "postgres",
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "",
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || process.env.POSTGRES_DATABASE || "pool_console"
  };
}

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      password_plain VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS pools (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_pool_user_name UNIQUE (user_id, name)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS captures (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pool_id INT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
      capture_date DATE NOT NULL,
      visible_total NUMERIC(16, 2) NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv_import')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uniq_capture_user_pool_date UNIQUE (user_id, pool_id, capture_date)
    )
  `);

  await db.query(
    `
      INSERT INTO users (username, password_plain)
      VALUES ('Andres', 'Andres$'), ('Sandra', 'Sandra$')
      ON CONFLICT (username) DO UPDATE SET password_plain = EXCLUDED.password_plain
    `
  );
  await ensurePoolRename("Andres", "97", "rojo");
  await ensurePoolRename("Andres", "09", "negro");
  await ensureDefaultPool("Sandra", "UNI");
}

async function ensureDefaultPool(username, poolName) {
  const { rows } = await db.query("SELECT id FROM users WHERE username = $1", [username]);
  const user = rows[0];
  if (!user) return;
  await db.query(
    `
      INSERT INTO pools (user_id, name)
      VALUES ($1, $2)
      ON CONFLICT (user_id, name) DO UPDATE SET active = TRUE
    `,
    [user.id, poolName]
  );
}

async function ensurePoolRename(username, oldName, newName) {
  const { rows: users } = await db.query("SELECT id FROM users WHERE username = $1", [username]);
  const user = users[0];
  if (!user) return;

  const { rows: oldPools } = await db.query("SELECT id FROM pools WHERE user_id = $1 AND name = $2", [user.id, oldName]);
  const { rows: newPools } = await db.query("SELECT id FROM pools WHERE user_id = $1 AND name = $2", [user.id, newName]);
  const oldPool = oldPools[0];
  const newPool = newPools[0];

  if (oldPool && !newPool) {
    await db.query("UPDATE pools SET name = $1, active = TRUE WHERE id = $2", [newName, oldPool.id]);
    return;
  }

  if (oldPool && newPool) {
    await db.query("UPDATE captures SET pool_id = $1, updated_at = NOW() WHERE pool_id = $2", [newPool.id, oldPool.id]);
    await db.query("DELETE FROM pools WHERE id = $1", [oldPool.id]);
    await db.query("UPDATE pools SET active = TRUE WHERE id = $1", [newPool.id]);
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
  const { rows: existingRows } = await db.query("SELECT id FROM pools WHERE user_id = $1 AND name = $2", [userId, poolName]);
  const existing = existingRows[0];
  if (existing) return existing.id;

  const { rows } = await db.query("INSERT INTO pools (user_id, name) VALUES ($1, $2) RETURNING id", [userId, poolName]);
  return rows[0].id;
}

async function rowsForUser(userId) {
  const { rows } = await db.query(
    `
      SELECT
        c.id,
        c.capture_date::text AS date,
        p.name AS pool,
        c.visible_total AS total,
        c.source,
        c.created_at,
        c.updated_at
      FROM captures c
      JOIN pools p ON p.id = c.pool_id
      WHERE c.user_id = $1
      ORDER BY c.capture_date ASC, p.name ASC
    `,
    [userId]
  );
  return recalculate(rows.map((row) => ({ ...row, total: Number(row.total) })));
}

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const { rows } = await db.query("SELECT id, username, password_plain FROM users WHERE LOWER(username) = LOWER($1)", [username]);
  const user = rows[0];

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
    await db.query(
      `
        INSERT INTO captures (user_id, pool_id, capture_date, visible_total, source)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, pool_id, capture_date)
        DO UPDATE SET visible_total = EXCLUDED.visible_total, source = EXCLUDED.source, updated_at = NOW()
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
  await db.query(
    "UPDATE captures SET capture_date = $1, pool_id = $2, visible_total = $3, source = 'manual', updated_at = NOW() WHERE id = $4 AND user_id = $5",
    [date, poolId, total, id, req.session.user.id]
  );
  res.json({ rows: await rowsForUser(req.session.user.id) });
});

app.delete("/api/rows/:id", requireAuth, async (req, res) => {
  await db.query("DELETE FROM captures WHERE id = $1 AND user_id = $2", [Number(req.params.id), req.session.user.id]);
  res.json({ rows: await rowsForUser(req.session.user.id) });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Pool Console Postgres listening on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
