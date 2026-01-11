import Database from "better-sqlite3";

export const PAUSE_MINUTES = 15; // M
export const MAX_TICKETS_PER_PERSON = 8; // N
export const MIN_SESSION_DURATION = 60;
export const MAX_SESSION_DURATION = 240; 

const DB_FILE = "./cinema.sqlite";
export const db = new Database(DB_FILE);

export function initDb() {
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS halls (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity >= 0)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      movie TEXT NOT NULL,
      start_at TEXT NOT NULL,          -- ISO string
      duration_min INTEGER NOT NULL CHECK (duration_min > 0),
      hall_id TEXT NOT NULL,
      FOREIGN KEY (hall_id) REFERENCES halls(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      tickets INTEGER NOT NULL CHECK (tickets > 0),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_hall ON sessions(hall_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_session_name ON bookings(session_id, customer_name);
  `);

  seedHallsIfEmpty();
}

function seedHallsIfEmpty() {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM halls`).get().c;
  if (count > 0) return;

  const insert = db.prepare(`INSERT INTO halls (id, name, capacity) VALUES (@id, @name, @capacity)`);

  const halls = [
    { id: "HALL-1", name: "Зал 1 (IMAX)", capacity: 120 },
    { id: "HALL-2", name: "Зал 2", capacity: 80 },
    { id: "HALL-3", name: "Зал 3 (VIP)", capacity: 40 }
  ];

  const tx = db.transaction(() => halls.forEach(h => insert.run(h)));
  tx();
}
