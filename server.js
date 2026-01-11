import express from "express";
import { v4 as uuidv4 } from "uuid";
import { db, initDb, PAUSE_MINUTES, MAX_TICKETS_PER_PERSON, MIN_SESSION_DURATION, MAX_SESSION_DURATION } from "./db.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

initDb();

const app = express();
const PORT = 3000;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));


function badRequest(res, message, details = null) {
  return res.status(400).json({ error: message, details });
}

function parseISOToMs(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function sessionWindowMs(session) {
  const startMs = parseISOToMs(session.start_at);
  const endMs = startMs + (session.duration_min + PAUSE_MINUTES) * 60_000;
  return { startMs, endMs };
}

function ensureSessionPayload(body) {
  const { movie, start_at, duration_min, hall_id } = body;
  if (typeof movie !== "string" || !movie.trim()) return { ok: false, msg: "movie должен быть непустой строкой" };
  if (typeof start_at !== "string" || !start_at.trim()) return { ok: false, msg: "start_at должен быть ISO-строкой даты" };
  const ms = parseISOToMs(start_at);
  if (ms === null) return { ok: false, msg: "start_at имеет неверный формат даты" };
  
  // Проверка на дату в прошлом
  if (ms < Date.now() + 60 * 60 * 1000) {
    return { ok: false, msg: "Сеанс должен быть не раньше чем через 1 час от текущего времени" };
  }
  
  const d = Number(duration_min);
  if (!Number.isInteger(d) || d <= 0) return { ok: false, msg: "duration_min должен быть целым числом > 0" };
  if (d < MIN_SESSION_DURATION || d > MAX_SESSION_DURATION) {
    return { ok: false, msg: `Длительность сеанса должна быть от ${MIN_SESSION_DURATION} до ${MAX_SESSION_DURATION} минут` };
  }
  if (typeof hall_id !== "string" || !hall_id.trim()) return { ok: false, msg: "hall_id должен быть строкой" };
  return { ok: true };
}

function hallExists(hallId) {
  return !!db.prepare(`SELECT 1 FROM halls WHERE id = ?`).get(hallId);
}

function checkSessionOverlap({ hall_id, start_at, duration_min, excludeSessionId = null }) {
  const newStartMs = parseISOToMs(start_at);
  const newEndMs = newStartMs + (duration_min + PAUSE_MINUTES) * 60_000;

  const rows = db.prepare(`
    SELECT id, start_at, duration_min
    FROM sessions
    WHERE hall_id = ?
    ${excludeSessionId ? "AND id <> ?" : ""}
  `).all(excludeSessionId ? [hall_id, excludeSessionId] : [hall_id]);

  for (const s of rows) {
    const { startMs, endMs } = sessionWindowMs(s);
    const overlaps = newStartMs < endMs && startMs < newEndMs;
    if (overlaps) {
      return {
        ok: false,
        conflict: {
          id: s.id,
          start_at: s.start_at,
          duration_min: s.duration_min
        }
      };
    }
  }
  return { ok: true };
}

function getHallCapacityBySession(sessionId) {
  const row = db.prepare(`
    SELECT h.capacity AS capacity
    FROM sessions s
    JOIN halls h ON h.id = s.hall_id
    WHERE s.id = ?
  `).get(sessionId);
  return row ? row.capacity : null;
}

function getTotalTicketsInSession(sessionId, excludeBookingIds = []) {
  if (!excludeBookingIds.length) {
    const row = db.prepare(`SELECT COALESCE(SUM(tickets), 0) AS t FROM bookings WHERE session_id = ?`).get(sessionId);
    return row.t;
  }
  const placeholders = excludeBookingIds.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT COALESCE(SUM(tickets), 0) AS t
    FROM bookings
    WHERE session_id = ?
      AND id NOT IN (${placeholders})
  `).get([sessionId, ...excludeBookingIds]);
  return row.t;
}

function findBookingByName(sessionId, customer_name) {
  return db.prepare(`
    SELECT id, session_id, customer_name, tickets
    FROM bookings
    WHERE session_id = ? AND customer_name = ?
  `).get(sessionId, customer_name);
}

function ensureBookingPayload(body) {
  const { customer_name, tickets } = body;
  if (typeof customer_name !== "string" || !customer_name.trim()) {
    return { ok: false, msg: "ФИО (customer_name) должно быть непустой строкой" };
  }
  const t = Number(tickets);
  if (!Number.isInteger(t) || t <= 0) return { ok: false, msg: "tickets должно быть целым числом > 0" };
  if (t > MAX_TICKETS_PER_PERSON) {
    return { ok: false, msg: `Превышен лимит билетов (максимум ${MAX_TICKETS_PER_PERSON})` };
  }
  return { ok: true };
}

function sessionExists(sessionId) {
  return !!db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId);
}

// Подготовленные запросы
const stmt = {
  getHall: db.prepare(`SELECT * FROM halls WHERE id = ?`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  getBooking: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
  getSessionWithHall: db.prepare(`
    SELECT s.*, h.name as hall_name, h.capacity as hall_capacity 
    FROM sessions s 
    JOIN halls h ON h.id = s.hall_id 
    WHERE s.id = ?
  `)
};

// API

// конфиг + залы (для клиента)
app.get("/api/config", (req, res) => {
  const halls = db.prepare(`SELECT id, name, capacity FROM halls ORDER BY name`).all();
  res.json({
    pauseMinutes: PAUSE_MINUTES,
    maxTicketsPerPerson: MAX_TICKETS_PER_PERSON,
    minSessionDuration: MIN_SESSION_DURATION,
    maxSessionDuration: MAX_SESSION_DURATION,
    halls
  });
});

app.get("/api/halls", (req, res) => {
  const halls = db.prepare(`SELECT id, name, capacity FROM halls ORDER BY name`).all();
  res.json(halls);
});

// CRUD сеансов
app.get("/api/sessions", (req, res) => {
  const rows = db.prepare(`
    SELECT
      s.id, s.movie, s.start_at, s.duration_min, s.hall_id,
      h.name AS hall_name, h.capacity AS hall_capacity,
      COALESCE(SUM(b.tickets), 0) AS booked_tickets
    FROM sessions s
    JOIN halls h ON h.id = s.hall_id
    LEFT JOIN bookings b ON b.session_id = s.id
    GROUP BY s.id
    ORDER BY s.start_at
  `).all();

  res.json(rows);
});

app.get("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  const row = stmt.getSessionWithHall.get(id);

  if (!row) return res.status(404).json({ error: "Сеанс не найден" });

  const bookings = db.prepare(`
    SELECT id, session_id, customer_name, tickets
    FROM bookings
    WHERE session_id = ?
    ORDER BY customer_name
  `).all(id);

  res.json({ ...row, bookings });
});

app.post("/api/sessions", (req, res) => {
  const payloadCheck = ensureSessionPayload(req.body);
  if (!payloadCheck.ok) return badRequest(res, payloadCheck.msg);

  const { movie, start_at, duration_min, hall_id } = req.body;

  if (!hallExists(hall_id)) return badRequest(res, "Указанный зал (hall_id) не существует");

  const overlap = checkSessionOverlap({ hall_id, start_at, duration_min });
  if (!overlap.ok) {
    return badRequest(res, "Сеанс пересекается по времени с другим сеансом в том же зале", overlap.conflict);
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO sessions (id, movie, start_at, duration_min, hall_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, movie.trim(), new Date(start_at).toISOString(), Number(duration_min), hall_id);

  res.status(201).json({ id });
});

app.put("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  if (!sessionExists(id)) return res.status(404).json({ error: "Сеанс не найден" });

  const payloadCheck = ensureSessionPayload(req.body);
  if (!payloadCheck.ok) return badRequest(res, payloadCheck.msg);

  const { movie, start_at, duration_min, hall_id } = req.body;

  if (!hallExists(hall_id)) return badRequest(res, "Указанный зал (hall_id) не существует");

  const overlap = checkSessionOverlap({ hall_id, start_at, duration_min, excludeSessionId: id });
  if (!overlap.ok) {
    return badRequest(res, "Сеанс пересекается по времени с другим сеансом в этом же зале (с учетом техпаузы)", overlap.conflict);
  }

  const currentSession = stmt.getSession.get(id);
  const booked = getTotalTicketsInSession(id);
  
  if (currentSession.hall_id !== hall_id) {
    const newCapacity = stmt.getHall.get(hall_id)?.capacity;
    if (newCapacity === undefined) return badRequest(res, "Не удалось определить вместимость нового зала");
    
    if (booked > newCapacity) {
      return badRequest(res, "Нельзя сменить зал: текущие брони превышают вместимость нового зала", {
        booked,
        newCapacity
      });
    }
  }

  db.prepare(`
    UPDATE sessions
    SET movie = ?, start_at = ?, duration_min = ?, hall_id = ?
    WHERE id = ?
  `).run(movie.trim(), new Date(start_at).toISOString(), Number(duration_min), hall_id, id);

  res.json({ ok: true });
});

app.delete("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  const info = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  if (info.changes === 0) return res.status(404).json({ error: "Сеанс не найден" });
  res.json({ ok: true });
});

// Bookings CRUD (внутри сеанса)
app.get("/api/sessions/:id/bookings", (req, res) => {
  const sessionId = req.params.id;
  if (!sessionExists(sessionId)) return res.status(404).json({ error: "Сеанс не найден" });

  const bookings = db.prepare(`
    SELECT id, session_id, customer_name, tickets
    FROM bookings
    WHERE session_id = ?
    ORDER BY customer_name
  `).all(sessionId);

  res.json(bookings);
});

app.post("/api/sessions/:id/bookings", (req, res) => {
  const sessionId = req.params.id;
  if (!sessionExists(sessionId)) return res.status(404).json({ error: "Сеанс не найден" });

  const payloadCheck = ensureBookingPayload(req.body);
  if (!payloadCheck.ok) return badRequest(res, payloadCheck.msg);

  const customer_name = req.body.customer_name.trim();
  const addTickets = Number(req.body.tickets);

  const capacity = getHallCapacityBySession(sessionId);
  if (capacity == null) return badRequest(res, "Не удалось определить вместимость зала");

  const existing = findBookingByName(sessionId, customer_name);

  if (existing) {
    const newTotalForPerson = existing.tickets + addTickets;
    if (newTotalForPerson > MAX_TICKETS_PER_PERSON) {
      return badRequest(res, "Нельзя добавить: превышен лимит билетов в одни руки для этого человека", {
        limit: MAX_TICKETS_PER_PERSON,
        current: existing.tickets,
        requestedAdd: addTickets
      });
    }

    const totalBefore = getTotalTicketsInSession(sessionId);
    if (totalBefore + addTickets > capacity) {
      return badRequest(res, "Нельзя добавить: не хватает мест в зале", {
        capacity,
        booked: totalBefore,
        requestedAdd: addTickets
      });
    }

    db.prepare(`UPDATE bookings SET tickets = ? WHERE id = ?`).run(newTotalForPerson, existing.id);
    return res.status(200).json({ mergedInto: existing.id, tickets: newTotalForPerson });
  }

  // new booking
  if (addTickets > MAX_TICKETS_PER_PERSON) {
    return badRequest(res, "Нельзя добавить: превышен лимит билетов в одни руки", {
      limit: MAX_TICKETS_PER_PERSON,
      requested: addTickets
    });
  }

  const totalBefore = getTotalTicketsInSession(sessionId);
  if (totalBefore + addTickets > capacity) {
    return badRequest(res, "Нельзя добавить: не хватает мест в зале", {
      capacity,
      booked: totalBefore,
      requestedAdd: addTickets
    });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO bookings (id, session_id, customer_name, tickets)
    VALUES (?, ?, ?, ?)
  `).run(id, sessionId, customer_name, addTickets);

  res.status(201).json({ id });
});

app.put("/api/sessions/:sid/bookings/:bid", (req, res) => {
  const { sid: sessionId, bid: bookingId } = req.params;
  if (!sessionExists(sessionId)) return res.status(404).json({ error: "Сеанс не найден" });

  const booking = stmt.getBooking.get(bookingId);
  if (!booking || booking.session_id !== sessionId) {
    return res.status(404).json({ error: "Бронь не найдена" });
  }

  const payloadCheck = ensureBookingPayload(req.body);
  if (!payloadCheck.ok) return badRequest(res, payloadCheck.msg);

  const customer_name = req.body.customer_name.trim();
  const newTickets = Number(req.body.tickets);

  const capacity = getHallCapacityBySession(sessionId);
  const excludeSelfTotal = getTotalTicketsInSession(sessionId, [bookingId]);

  const other = findBookingByName(sessionId, customer_name);
  if (other && other.id !== bookingId) {
    const mergedTickets = other.tickets + newTickets;
    if (mergedTickets > MAX_TICKETS_PER_PERSON) {
      return badRequest(res, "Нельзя сохранить: превышен лимит билетов", {
        limit: MAX_TICKETS_PER_PERSON,
        otherTickets: other.tickets,
        thisNewTickets: newTickets
      });
    }

    const totalExcludingBoth = getTotalTicketsInSession(sessionId, [bookingId, other.id]);
    if (totalExcludingBoth + mergedTickets > capacity) {
      return badRequest(res, "Нельзя сохранить: не хватает мест в зале", {
        capacity,
        bookedExcludingBoth: totalExcludingBoth,
        mergedTickets
      });
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE bookings SET tickets = ? WHERE id = ?`).run(mergedTickets, other.id);
      db.prepare(`DELETE FROM bookings WHERE id = ?`).run(bookingId);
    });
    tx();

    return res.json({ mergedInto: other.id, tickets: mergedTickets, deleted: bookingId });
  }

  if (newTickets > MAX_TICKETS_PER_PERSON) {
    return badRequest(res, "Нельзя сохранить: превышен лимит билетов", {
      limit: MAX_TICKETS_PER_PERSON,
      requested: newTickets
    });
  }

  if (excludeSelfTotal + newTickets > capacity) {
    return badRequest(res, "Нельзя сохранить: не хватает мест в зале", {
      capacity,
      bookedExcludingThis: excludeSelfTotal,
      requested: newTickets
    });
  }

  db.prepare(`UPDATE bookings SET customer_name = ?, tickets = ? WHERE id = ?`)
    .run(customer_name, newTickets, bookingId);

  res.json({ ok: true });
});

app.delete("/api/sessions/:sid/bookings/:bid", (req, res) => {
  const { sid: sessionId, bid: bookingId } = req.params;
  const info = db.prepare(`DELETE FROM bookings WHERE id = ? AND session_id = ?`).run(bookingId, sessionId);
  if (info.changes === 0) return res.status(404).json({ error: "Бронь не найдена" });
  res.json({ ok: true });
});

app.post("/api/bookings/:bid/move", (req, res) => {
  const bookingId = req.params.bid;
  const { toSessionId } = req.body || {};
  if (typeof toSessionId !== "string" || !toSessionId.trim()) return badRequest(res, "toSessionId обязателен");

  const booking = stmt.getBooking.get(bookingId);
  if (!booking) return res.status(404).json({ error: "Бронь не найдена" });

  const fromSession = stmt.getSession.get(booking.session_id);
  const toSession = stmt.getSession.get(toSessionId);

  if (!toSession) return res.status(404).json({ error: "Целевой сеанс не найден" });
  if (fromSession.movie !== toSession.movie) {
    return badRequest(res, "Целевой сеанс должен быть с тем же фильмом", {
      fromMovie: fromSession.movie,
      toMovie: toSession.movie
    });
  }

  const capacity = getHallCapacityBySession(toSessionId);
  if (capacity == null) return badRequest(res, "Не удалось определить вместимость зала целевого сеанса");

  const existing = findBookingByName(toSessionId, booking.customer_name);

  if (existing) {
    const mergedTickets = existing.tickets + booking.tickets;
    if (mergedTickets > MAX_TICKETS_PER_PERSON) {
      return badRequest(res, "Превышен лимит билетов в одни руки", {
        limit: MAX_TICKETS_PER_PERSON,
        existing: existing.tickets,
        moving: booking.tickets
      });
    }

    const totalExcludingExisting = getTotalTicketsInSession(toSessionId, [existing.id]);
    if (totalExcludingExisting + mergedTickets > capacity) {
      return badRequest(res, "Не хватает мест в целевом зале", {
        capacity,
        bookedExcludingExisting: totalExcludingExisting,
        mergedTickets
      });
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE bookings SET tickets = ? WHERE id = ?`).run(mergedTickets, existing.id);
      db.prepare(`DELETE FROM bookings WHERE id = ?`).run(bookingId);
    });
    tx();

    return res.json({ moved: true, mergedInto: existing.id, deleted: bookingId, tickets: mergedTickets });
  }

  const totalTo = getTotalTicketsInSession(toSessionId);
  if (totalTo + booking.tickets > capacity) {
    return badRequest(res, "Не хватает мест в целевом зале", {
      capacity,
      booked: totalTo,
      moving: booking.tickets
    });
  }

  if (booking.tickets > MAX_TICKETS_PER_PERSON) {
    return badRequest(res, "Некорректная бронь: превышен лимит билетов", { limit: MAX_TICKETS_PER_PERSON });
  }

  db.prepare(`UPDATE bookings SET session_id = ? WHERE id = ?`).run(toSessionId, bookingId);
  res.json({ moved: true, bookingId, toSessionId });
});

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// Обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Внутренняя ошибка сервера',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Конфигурация: Техпауза M = ${PAUSE_MINUTES} мин, Лимит N = ${MAX_TICKETS_PER_PERSON} билетов`);
});
