let CONFIG = null;
let sessions = [];
let selectedSessionId = null;

const el = (id) => document.getElementById(id);

function toast(msg, isError = false) {
  const t = el("toast");
  t.hidden = false;
  t.textContent = msg;
  t.className = isError ? "toast error" : "toast success";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), 4000);
}

function toLocalInputValue(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function parseDurationToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getStatusClass(booked, capacity) {
  const percent = (booked / capacity) * 100;
  if (percent >= 90) return "status-full";
  if (percent >= 70) return "status-warning";
  return "status-available";
}

async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = data?.error || `Ошибка запроса: ${res.status}`;
      throw new Error(msg);
    }
    
    return await res.json();
  } catch (err) {
    console.error(`API ошибка ${path}:`, err);
    throw err;
  }
}

// ---------------- init ----------------
async function init() {
  try {
    console.log("Загрузка конфигурации...");
    
    // Загружаем конфигурацию
    CONFIG = await api("/api/config");
    console.log("Конфигурация загружена:", CONFIG);
    
    // Отображаем конфигурацию
    el("configLine").innerHTML =
      `<i class="fas fa-clock"></i> Техпауза M = ${CONFIG.pauseMinutes} мин · ` +
      `<i class="fas fa-ticket-alt"></i> Лимит N = ${CONFIG.maxTicketsPerPerson} билетов в одни руки`;

    // Загружаем залы в селект
    loadHalls();
    
    // Настраиваем UI
    wireUI();
    
    // Загружаем сеансы
    await refreshSessions();
    
    console.log("Инициализация завершена");
  } catch (err) {
    console.error("Ошибка инициализации:", err);
    toast("Не удалось загрузить приложение: " + err.message, true);
  }
}

function loadHalls() {
  const hallSel = el("sHall");
  hallSel.innerHTML = "";
  
  if (CONFIG && CONFIG.halls && Array.isArray(CONFIG.halls) && CONFIG.halls.length > 0) {
    CONFIG.halls.forEach(h => {
      const opt = document.createElement("option");
      opt.value = h.id;
      opt.textContent = `${h.name} — ${h.capacity} мест`;
      hallSel.appendChild(opt);
    });
    console.log("Залы загружены:", CONFIG.halls.length);
  } else {
    console.error("Залы не загружены или пустые");
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Нет доступных залов";
    hallSel.appendChild(opt);
  }
}

function wireUI() {
  console.log("Настройка UI...");
  
  // Кнопка нового сеанса
  el("btnNewSession").addEventListener("click", () => {
    console.log("Клик по 'Новый сеанс'");
    openSessionModalForCreate();
  });
  
  // Закрытие модального окна
  el("closeSessionModal").addEventListener("click", () => {
    console.log("Закрытие по крестику");
    el("sessionModal").hidden = true;
  });
  
  el("sCancel").addEventListener("click", () => {
    console.log("Закрытие по кнопке Отмена");
    el("sessionModal").hidden = true;
  });
  
  // Закрытие по клику на фон
  el("sessionModal").addEventListener("click", (e) => {
    if (e.target === el("sessionModal")) {
      console.log("Закрытие по клику на фон");
      el("sessionModal").hidden = true;
    }
  });
  
  // Форма сеанса
  el("sessionForm").addEventListener("submit", onSaveSession);
  el("sDelete").addEventListener("click", onDeleteSession);

  // Форма бронирования
  el("bookingForm").addEventListener("submit", onSaveBooking);
  el("bCancel").addEventListener("click", resetBookingForm);
  
  console.log("UI настроен");
}

// ---------------- sessions UI ----------------
async function refreshSessions() {
  try {
    console.log("Загрузка сеансов...");
    const data = await api("/api/sessions");
    
    // Убедимся, что sessions - массив
    sessions = Array.isArray(data) ? data : [];
    console.log("Сеансы загружены:", sessions.length, "шт.");
    
    renderSessions();

    // если выбранный сеанс исчез — сброс
    if (selectedSessionId && !sessions.some(s => s.id === selectedSessionId)) {
      selectedSessionId = null;
      renderBookingsPanel(null);
    } else if (selectedSessionId) {
      await loadAndRenderBookings(selectedSessionId);
    }
  } catch (err) {
    console.error("Ошибка загрузки сеансов:", err);
    toast("Ошибка загрузки сеансов: " + err.message, true);
  }
}

function renderSessions() {
  const tbody = el("sessionsTable").querySelector("tbody");
  tbody.innerHTML = "";

  let totalSessions = 0;
  let totalBooked = 0;

  if (!Array.isArray(sessions) || sessions.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td colspan="6" style="text-align: center; padding: 40px; color: var(--text-light);">
        <i class="fas fa-film" style="font-size: 24px; margin-bottom: 10px; display: block;"></i>
        Нет сеансов. Создайте первый сеанс.
      </td>
    `;
    tbody.appendChild(tr);
    el("sessionsStats").textContent = "0 сеансов";
    return;
  }

  for (const s of sessions) {
    totalSessions++;
    const booked = Number(s.booked_tickets || 0);
    const cap = Number(s.hall_capacity || 0);
    totalBooked += booked;

    const statusClass = getStatusClass(booked, cap);
    
    const tr = document.createElement("tr");
    if (s.id === selectedSessionId) {
      tr.style.backgroundColor = "rgba(255, 126, 185, 0.05)";
    }

    tr.innerHTML = `
      <td><strong>${escapeHtml(s.movie)}</strong></td>
      <td>${new Date(s.start_at).toLocaleString("ru-RU")}</td>
      <td>${minutesToHHMM(Number(s.duration_min))}</td>
      <td>
        <div>${escapeHtml(s.hall_name)}</div>
        <small class="badge">ID: ${escapeHtml(s.hall_id)}</small>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="status-indicator ${statusClass}"></span>
          <span class="badge ${booked >= cap ? "badge-danger" : booked >= cap * 0.7 ? "badge-warning" : "badge-success"}">
            ${booked}/${cap}
          </span>
        </div>
      </td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary" data-act="bookings" title="Просмотр броней">
            <i class="fas fa-ticket-alt"></i>
          </button>
          <button class="btn btn-secondary" data-act="edit" title="Редактировать">
            <i class="fas fa-edit"></i>
          </button>
        </div>
      </td>
    `;

    tr.querySelector('[data-act="bookings"]').addEventListener("click", async () => {
      console.log("Выбран сеанс для броней:", s.id);
      selectedSessionId = s.id;
      await loadAndRenderBookings(s.id);
      renderSessions(); // Перерисовываем, чтобы выделить выбранный
    });

    tr.querySelector('[data-act="edit"]').addEventListener("click", () => {
      console.log("Редактирование сеанса:", s.id);
      openSessionModalForEdit(s.id);
    });

    tbody.appendChild(tr);
  }

  // Обновляем статистику
  el("sessionsStats").textContent = `${totalSessions} сеансов • ${totalBooked} забронировано`;
}

function openSessionModalForCreate() {
  console.log("Открытие модального окна для создания");
  
  el("sessionModalTitle").innerHTML = '<i class="fas fa-plus"></i> Новый сеанс';
  el("sId").value = "";
  el("sMovie").value = "";
  
  // Устанавливаем время на ближайший час
  const now = new Date();
  now.setHours(now.getHours() + 1);
  now.setMinutes(0);
  el("sStart").value = toLocalInputValue(now.toISOString());
  
  el("sDuration").value = "02:00";
  
  // Устанавливаем первый доступный зал
  if (CONFIG && CONFIG.halls && Array.isArray(CONFIG.halls) && CONFIG.halls.length > 0) {
    el("sHall").value = CONFIG.halls[0].id;
  } else {
    el("sHall").value = "";
  }
  
  el("sDelete").hidden = true;
  el("sCancel").hidden = false;

  el("sessionForm").dataset.mode = "create";
  el("sessionForm").dataset.id = "";
  
  // Показываем модальное окно
  el("sessionModal").hidden = false;
  console.log("Модальное окно показано");
}

async function openSessionModalForEdit(sessionId) {
  try {
    console.log("Загрузка сеанса для редактирования:", sessionId);
    const s = await api(`/api/sessions/${sessionId}`);
    
    el("sessionModalTitle").innerHTML = '<i class="fas fa-edit"></i> Редактирование сеанса';
    el("sId").value = s.id;
    el("sMovie").value = s.movie;
    el("sStart").value = toLocalInputValue(s.start_at);
    el("sDuration").value = minutesToHHMM(Number(s.duration_min));
    el("sHall").value = s.hall_id;
    el("sDelete").hidden = false;
    el("sCancel").hidden = false;

    el("sessionForm").dataset.mode = "edit";
    el("sessionForm").dataset.id = s.id;
    
    el("sessionModal").hidden = false;
    console.log("Модальное окно редактирования показано");
  } catch (err) {
    console.error("Ошибка загрузки сеанса:", err);
    toast("Ошибка загрузки сеанса: " + err.message, true);
  }
}

async function onSaveSession(e) {
  e.preventDefault();
  console.log("Сохранение сеанса");

  const mode = el("sessionForm").dataset.mode;
  const id = el("sessionForm").dataset.id;

  const movie = el("sMovie").value.trim();
  const startLocal = el("sStart").value;
  const durationText = el("sDuration").value;
  const hall_id = el("sHall").value;

  console.log("Данные формы:", { movie, startLocal, durationText, hall_id });

  if (!hall_id) {
    toast("Выберите зал", true);
    return;
  }

  const duration_min = parseDurationToMinutes(durationText);
  if (duration_min == null) {
    toast("Длительность должна быть в формате чч:мм (например, 02:15)", true);
    return;
  }

  if (duration_min < 60 || duration_min > 240) {
    toast("Длительность сеанса должна быть от 1 до 4 часов", true);
    return;
  }

  const start_at = new Date(startLocal).toISOString();

  try {
    if (mode === "create") {
      await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ movie, start_at, duration_min, hall_id })
      });
      toast("Сеанс успешно добавлен");
    } else {
      await api(`/api/sessions/${id}`, {
        method: "PUT",
        body: JSON.stringify({ movie, start_at, duration_min, hall_id })
      });
      toast("Сеанс успешно сохранён");
    }

    el("sessionModal").hidden = true;
    await refreshSessions();
  } catch (err) {
    console.error("Ошибка сохранения сеанса:", err);
    toast(err.message, true);
  }
}

async function onDeleteSession() {
  const id = el("sessionForm").dataset.id;
  if (!id) return;

  if (!confirm("Вы уверены, что хотите удалить сеанс?\nВсе брони этого сеанса также будут удалены.")) return;

  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    toast("Сеанс успешно удалён");
    el("sessionModal").hidden = true;
    await refreshSessions();
  } catch (err) {
    toast(err.message, true);
  }
}

// bookings UI
async function loadAndRenderBookings(sessionId) {
  try {
    console.log("Загрузка броней для сеанса:", sessionId);
    const s = await api(`/api/sessions/${sessionId}`);
    renderBookingsPanel(s);
  } catch (err) {
    console.error("Ошибка загрузки броней:", err);
    toast("Ошибка загрузки броней: " + err.message, true);
  }
}

function renderBookingsPanel(sessionObj) {
  resetBookingForm();

  if (!sessionObj) {
    el("selectedSessionLine").innerHTML =
      '<div class="placeholder"><i class="fas fa-film"></i> Выберите сеанс для просмотра броней</div>';
    el("bookingsTable").querySelector("tbody").innerHTML = "";
    el("bookingsStats").textContent = "0 броней";
    return;
  }

  const bookings = Array.isArray(sessionObj.bookings) ? sessionObj.bookings : [];
  const booked = bookings.reduce((a, b) => a + Number(b.tickets || 0), 0);
  const capacity = sessionObj.hall_capacity || 0;
  const statusClass = getStatusClass(booked, capacity);
  
  el("selectedSessionLine").innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h4 style="margin: 0 0 8px 0; color: var(--text);">
          <i class="fas fa-film"></i> ${escapeHtml(sessionObj.movie)}
        </h4>
        <div style="color: var(--text-light); font-size: 13px;">
          <i class="fas fa-calendar"></i> ${new Date(sessionObj.start_at).toLocaleString("ru-RU")} • 
          <i class="fas fa-door-open"></i> ${escapeHtml(sessionObj.hall_name)}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span class="badge ${booked >= capacity ? "badge-danger" : booked >= capacity * 0.7 ? "badge-warning" : "badge-success"}">
          <i class="fas fa-ticket-alt"></i> ${booked}/${capacity}
        </span>
        <span class="status-indicator ${statusClass}"></span>
      </div>
    </div>
  `;

  // таблица броней
  const tbody = el("bookingsTable").querySelector("tbody");
  tbody.innerHTML = "";

  if (!Array.isArray(sessions)) sessions = [];
  const sameMovieTargets = sessions
    .filter(x => x.movie === sessionObj.movie && x.id !== sessionObj.id)
    .map(x => ({
      id: x.id,
      label: `${new Date(x.start_at).toLocaleDateString("ru-RU", { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} • ${x.hall_name}`
    }));

  let totalBookings = 0;

  for (const b of bookings) {
    totalBookings++;
    const tr = document.createElement("tr");

    const moveSelect = document.createElement("select");
    moveSelect.innerHTML = `<option value="">— выбрать сеанс —</option>` + sameMovieTargets
      .map(t => `<option value="${t.id}">${escapeHtml(t.label)}</option>`)
      .join("");
    moveSelect.style.minWidth = "240px";

    const moveBtn = document.createElement("button");
    moveBtn.className = "btn btn-secondary";
    moveBtn.innerHTML = '<i class="fas fa-exchange-alt"></i> Перебросить';
    moveBtn.disabled = true;
    moveBtn.style.marginLeft = "8px";

    moveSelect.addEventListener("change", () => {
      moveBtn.disabled = !moveSelect.value;
    });

    moveBtn.addEventListener("click", async () => {
      if (!moveSelect.value) return;
      if (!confirm(`Перебросить бронь "${b.customer_name}" на выбранный сеанс?`)) return;
      
      try {
        await api(`/api/bookings/${b.id}/move`, {
          method: "POST",
          body: JSON.stringify({ toSessionId: moveSelect.value })
        });
        toast("Бронь успешно переброшена");
        await refreshSessions();
        await loadAndRenderBookings(selectedSessionId);
      } catch (err) {
        toast(err.message, true);
      }
    });

    const actionsTd = document.createElement("td");
    actionsTd.className = "action-buttons";

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-secondary";
    editBtn.innerHTML = '<i class="fas fa-edit"></i>';
    editBtn.title = "Редактировать";
    editBtn.addEventListener("click", () => {
      el("bName").value = b.customer_name;
      el("bTickets").value = b.tickets;
      el("bEditingId").value = b.id;
      el("bSubmit").innerHTML = '<i class="fas fa-save"></i> Сохранить';
      el("bCancel").hidden = false;
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger";
    delBtn.innerHTML = '<i class="fas fa-trash"></i>';
    delBtn.title = "Удалить";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Удалить бронь "${b.customer_name}"?`)) return;
      try {
        await api(`/api/sessions/${sessionObj.id}/bookings/${b.id}`, { method: "DELETE" });
        toast("Бронь успешно удалена");
        await refreshSessions();
        await loadAndRenderBookings(selectedSessionId);
      } catch (err) {
        toast(err.message, true);
      }
    });

    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(delBtn);

    const tdMove = document.createElement("td");
    tdMove.style.display = "flex";
    tdMove.style.alignItems = "center";
    tdMove.style.gap = "8px";
    tdMove.appendChild(moveSelect);
    tdMove.appendChild(moveBtn);

    tr.innerHTML = `
      <td><strong>${escapeHtml(b.customer_name)}</strong></td>
      <td>
        <span class="badge ${Number(b.tickets) >= (CONFIG?.maxTicketsPerPerson || 8) ? "badge-warning" : "badge-primary"}">
          <i class="fas fa-ticket-alt"></i> ${Number(b.tickets)} шт.
        </span>
      </td>
    `;
    tr.appendChild(tdMove);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  }

  // Обновляем статистику
  el("bookingsStats").textContent = `${totalBookings} броней • ${booked} билетов`;
}

async function onSaveBooking(e) {
  e.preventDefault();
  if (!selectedSessionId) {
    toast("Сначала выберите сеанс", true);
    return;
  }

  const customer_name = el("bName").value.trim();
  const tickets = Number(el("bTickets").value);
  const editingId = el("bEditingId").value;

  if (!customer_name) {
    toast("Введите ФИО", true);
    return;
  }

  if (!tickets || tickets < 1) {
    toast("Введите количество билетов (от 1)", true);
    return;
  }

  const maxTickets = CONFIG?.maxTicketsPerPerson || 8;
  if (tickets > maxTickets) {
    toast(`Нельзя забронировать более ${maxTickets} билетов в одни руки`, true);
    return;
  }

  try {
    if (!editingId) {
      // create/merge
      await api(`/api/sessions/${selectedSessionId}/bookings`, {
        method: "POST",
        body: JSON.stringify({ customer_name, tickets })
      });
      toast("Бронь добавлена/суммирована");
    } else {
      // update
      await api(`/api/sessions/${selectedSessionId}/bookings/${editingId}`, {
        method: "PUT",
        body: JSON.stringify({ customer_name, tickets })
      });
      toast("Бронь сохранена");
    }

    resetBookingForm();
    await refreshSessions();
    await loadAndRenderBookings(selectedSessionId);
  } catch (err) {
    toast(err.message, true);
  }
}

function resetBookingForm() {
  el("bName").value = "";
  el("bTickets").value = "";
  el("bEditingId").value = "";
  el("bSubmit").innerHTML = '<i class="fas fa-check"></i> Добавить/суммировать';
  el("bCancel").hidden = true;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
  console.log("DOM загружен, запуск инициализации...");
  init().catch(err => {
    console.error("Ошибка запуска приложения:", err);
    toast("Не удалось запустить приложение: " + err.message, true);
  });
});
