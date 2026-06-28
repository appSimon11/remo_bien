CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_plain VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pools (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_pool_user_name UNIQUE (user_id, name)
);

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
);

INSERT INTO users (username, password_plain)
VALUES ('Andres', 'Andres$'), ('Sandra', 'Sandra$')
ON CONFLICT (username) DO UPDATE SET password_plain = EXCLUDED.password_plain;

INSERT INTO pools (user_id, name)
SELECT id, 'rojo' FROM users WHERE username = 'Andres'
ON CONFLICT (user_id, name) DO UPDATE SET active = TRUE;

INSERT INTO pools (user_id, name)
SELECT id, 'negro' FROM users WHERE username = 'Andres'
ON CONFLICT (user_id, name) DO UPDATE SET active = TRUE;

INSERT INTO pools (user_id, name)
SELECT id, 'UNI' FROM users WHERE username = 'Sandra'
ON CONFLICT (user_id, name) DO UPDATE SET active = TRUE;
