CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  room        TEXT NOT NULL,
  handle      TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  dims        TEXT NOT NULL,   -- JSON: 10 numbers 0..1
  card        TEXT NOT NULL,   -- JSON: pseudonymous card
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (room, handle)
);
CREATE INDEX IF NOT EXISTS idx_profiles_room ON profiles(room);
-- the matches pool reads the newest profiles per room
CREATE INDEX IF NOT EXISTS idx_profiles_room_updated ON profiles(room, updated_at DESC);

CREATE TABLE IF NOT EXISTS reveals (
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  contact     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_reveals_to ON reveals(to_id);
