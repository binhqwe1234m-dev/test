// ============================================================
// Cobelix AFK Bot Dashboard — Client
// ============================================================

const socket = io();

// ─── i18n ───
const I18N = {
  en: {
    stat_server: 'Server', stat_username: 'Username', stat_version: 'Version',
    stat_health: 'Health', stat_food: 'Food', stat_position: 'Position', stat_uptime: 'Uptime',
    btn_connect: 'Connect', btn_disconnect: 'Disconnect',
    btn_auto_on: 'Auto-Reconnect ON', btn_auto_off: 'Auto-Reconnect OFF',
    btn_clear: 'Clear Console', btn_send: 'Send',
    tab_console: 'Console', tab_viewer: 'Bot View',
    console_output: 'Console Output',
    chat_placeholder: 'Type a chat message or command...',
    viewer_offline: 'Bot disconnected',
    viewer_offline_hint: 'Connect the bot to get 3D viewer',
    modal_title: 'Server Settings',
    label_server: 'Server Address', ph_server: 'IP:Port or Domain:Port (e.g. play.example.com:25565)',
    hint_port: 'Port defaults to 25565 if omitted',
    label_username: 'Bot Username', ph_username: 'AFK_Bot',
    label_password: 'Password', ph_password: 'Used for /login and /register',
    label_first_msg: 'First-Time Message', ph_first_msg: 'Sent after joining (e.g. /help)',
    hint_first_msg: 'Optional — sent once after bot joins the server',
    btn_cancel: 'Cancel', btn_save: 'Save & Connect',
    log_lines: '{n} lines',
  },
  vi: {
    stat_server: 'Máy chủ', stat_username: 'Tên bot', stat_version: 'Phiên bản',
    stat_health: 'Máu', stat_food: 'Đồ ăn', stat_position: 'Toạ độ', stat_uptime: 'Thời gian',
    btn_connect: 'Kết nối', btn_disconnect: 'Ngắt kết nối',
    btn_auto_on: 'Tự kết nối lại BẬT', btn_auto_off: 'Tự kết nối lại TẮT',
    btn_clear: 'Xoá Console', btn_send: 'Gửi',
    tab_console: 'Console', tab_viewer: 'Góc nhìn Bot',
    console_output: 'Console Output',
    chat_placeholder: 'Nhập tin nhắn hoặc lệnh...',
    viewer_offline: 'Bot chưa kết nối',
    viewer_offline_hint: 'Kết nối bot để xem 3D viewer',
    modal_title: 'Cài đặt máy chủ',
    label_server: 'Địa chỉ máy chủ', ph_server: 'IP:Port hoặc Domain:Port (VD: play.example.com:25565)',
    hint_port: 'Port mặc định là 25565 nếu bỏ trống',
    label_username: 'Tên bot', ph_username: 'AFK_Bot',
    label_password: 'Mật khẩu', ph_password: 'Dùng cho /login và /register',
    label_first_msg: 'Tin nhắn lần đầu', ph_first_msg: 'Gửi sau khi vào server (VD: /help)',
    hint_first_msg: 'Tuỳ chọn — gửi một lần khi bot vào server',
    btn_cancel: 'Huỷ', btn_save: 'Lưu & Kết nối',
    log_lines: '{n} dòng',
  }
};

let currentLang = localStorage.getItem('cobelix-lang') || 'en';

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
}

function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val) el.placeholder = val;
  });
  // Update log count
  logCount.textContent = t('log_lines').replace('{n}', lineCount);
  // Update flag label
  document.getElementById('langFlag').textContent = currentLang.toUpperCase();
  // Update active state in menu
  document.querySelectorAll('.lang-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  });
  document.documentElement.lang = currentLang;
}

// DOM — Tabs
const tabBtns        = document.querySelectorAll('.tab-btn');
const tabConsole     = document.getElementById('tabConsole');
const tabViewer      = document.getElementById('tabViewer');
const viewerDot      = document.getElementById('viewerDot');
const viewerIframe   = document.getElementById('viewerIframe');
const viewerOffline  = document.getElementById('viewerOffline');

// DOM
const consoleBody    = document.getElementById('consoleBody');
const chatInput      = document.getElementById('chatInput');
const btnSend        = document.getElementById('btnSend');
const btnConnect     = document.getElementById('btnConnect');
const btnDisconnect  = document.getElementById('btnDisconnect');
const btnAutoOn      = document.getElementById('btnAutoReconnectOn');
const btnAutoOff     = document.getElementById('btnAutoReconnectOff');
const btnClear       = document.getElementById('btnClear');
const logCount       = document.getElementById('logCount');
const statusBadge    = document.getElementById('statusBadge');
const themeToggle    = document.getElementById('themeToggle');
const btnEdit        = document.getElementById('btnEdit');

// Modal DOM
const setupModal     = document.getElementById('setupModal');
const setupForm      = document.getElementById('setupForm');
const btnModalClose  = document.getElementById('btnModalClose');
const btnModalCancel = document.getElementById('btnModalCancel');
const inputServer    = document.getElementById('inputServer');
const inputUsername  = document.getElementById('inputUsername');
const inputPassword  = document.getElementById('inputPassword');
const inputFirstMsg  = document.getElementById('inputFirstMsg');

// Stats
const statServer  = document.getElementById('statServer');
const statUser    = document.getElementById('statUser');
const statVersion = document.getElementById('statVersion');
const statHealth  = document.getElementById('statHealth');
const statFood    = document.getElementById('statFood');
const healthBar   = document.getElementById('healthBar');
const foodBar     = document.getElementById('foodBar');
const statPos     = document.getElementById('statPos');
const statUptime  = document.getElementById('statUptime');

const MAX_VISIBLE_LINES = 100;
let lineCount = 0;
let autoScroll = true;
let uptimeMs = 0;
let uptimeInterval = null;

// ─── Theme ───
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('cobelix-theme', theme);
}

// Init theme
(function initTheme() {
  const saved = localStorage.getItem('cobelix-theme');
  if (saved) {
    setTheme(saved);
  } else {
    setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
})();

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('cobelix-theme')) {
    setTheme(e.matches ? 'dark' : 'light');
  }
});

// ─── Language dropdown ───
const langDropdown = document.getElementById('langDropdown');
const langToggle   = document.getElementById('langToggle');
const langMenu     = document.getElementById('langMenu');

langToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  langDropdown.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (!langDropdown.contains(e.target)) {
    langDropdown.classList.remove('open');
  }
});

document.querySelectorAll('.lang-option').forEach(btn => {
  btn.addEventListener('click', () => {
    currentLang = btn.dataset.lang;
    localStorage.setItem('cobelix-lang', currentLang);
    applyLang();
    langDropdown.classList.remove('open');
  });
});

// Apply language on load
applyLang();

// ─── Icons map ───
const ICONS = {
  info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌',
  combat: '⚔️', brain: '🧠', chat: '💬', debug: '🐛'
};

// ─── Log rendering ───
function appendLog(entry) {
  const div = document.createElement('div');
  div.className = 'log-line';

  const icon = ICONS[entry.type] || '•';
  const typeClass = `log-type-${entry.type}`;

  let html = `<span class="log-time">[${entry.time}]</span> ${icon} <span class="log-type ${typeClass}">[${entry.type.toUpperCase()}]</span>: ${escHtml(entry.msg)}`;
  if (entry.detail) {
    html += `<br><span class="log-detail">└─ ➤ ${escHtml(entry.detail)}</span>`;
  }
  div.innerHTML = html;
  consoleBody.appendChild(div);
  lineCount++;

  // Rotate: remove oldest lines when exceeding limit
  const overflow = consoleBody.children.length - MAX_VISIBLE_LINES;
  if (overflow > 0) {
    // Bulk trim: remove instantly if many, animate if just 1
    if (overflow === 1) {
      const oldest = consoleBody.firstElementChild;
      oldest.classList.add('rotating-out');
      setTimeout(() => { if (oldest.parentNode) oldest.remove(); }, 300);
    } else {
      for (let i = 0; i < overflow; i++) {
        consoleBody.firstElementChild?.remove();
      }
    }
  }

  logCount.textContent = t('log_lines').replace('{n}', lineCount);

  if (autoScroll) {
    requestAnimationFrame(() => {
      consoleBody.scrollTop = consoleBody.scrollHeight;
    });
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Detect if user scrolled up
consoleBody.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = consoleBody;
  autoScroll = (scrollHeight - scrollTop - clientHeight) < 40;
});

// ─── Uptime formatter ───
function formatUptime(ms) {
  if (ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ─── Socket events ───
socket.on('init', (data) => {
  consoleBody.innerHTML = '';
  lineCount = 0;
  data.logs.forEach(appendLog);
});

socket.on('log', appendLog);

socket.on('status', (s) => {
  // Badge
  statusBadge.textContent = s.status.toUpperCase();
  statusBadge.className = 'status-badge ' + s.status;

  // Stats
  statServer.textContent = s.server || '—';
  statUser.textContent = s.username || '—';
  statVersion.textContent = s.version || '—';

  if (s.status === 'online') {
    statHealth.textContent = `${s.health?.toFixed?.(1) ?? s.health}/20`;
    statFood.textContent = `${s.food}/20`;
    healthBar.style.width = `${(s.health / 20) * 100}%`;
    foodBar.style.width = `${(s.food / 20) * 100}%`;
    statPos.textContent = s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '—';

    uptimeMs = s.uptime || 0;
    statUptime.textContent = formatUptime(uptimeMs);
    if (uptimeInterval) clearInterval(uptimeInterval);
    uptimeInterval = setInterval(() => {
      uptimeMs += 1000;
      statUptime.textContent = formatUptime(uptimeMs);
    }, 1000);
  } else {
    if (s.status === 'offline') {
      statHealth.textContent = '—';
      statFood.textContent = '—';
      healthBar.style.width = '0%';
      foodBar.style.width = '0%';
      statPos.textContent = '—';
      statUptime.textContent = '—';
      if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
    }
  }
});

// ─── Controls ───
btnConnect.addEventListener('click', () => socket.emit('command', 'connect'));
btnDisconnect.addEventListener('click', () => socket.emit('command', 'disconnect'));
btnAutoOn.addEventListener('click', () => socket.emit('command', 'reconnect-on'));
btnAutoOff.addEventListener('click', () => socket.emit('command', 'reconnect-off'));
btnClear.addEventListener('click', () => {
  consoleBody.innerHTML = '';
  lineCount = 0;
  logCount.textContent = t('log_lines').replace('{n}', 0);
});

// ─── Chat input ───
function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat', msg);
  chatInput.value = '';
}

btnSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

// Focus input on any keypress when not focused (console tab only)
document.addEventListener('keydown', (e) => {
  if (setupModal.classList.contains('active')) return;
  if (activeTab !== 'console') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'IFRAME') return;
  if (e.key === '/' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
    chatInput.focus();
  }
});

// ─── Setup Modal ───
function openModal() {
  // Load current settings
  fetch('/api/settings').then(r => r.json()).then(s => {
    const addr = s.port && s.port !== 25565 ? `${s.ip}:${s.port}` : (s.ip || '');
    inputServer.value = addr;
    inputUsername.value = s.username || '';
    inputPassword.value = s.password || '';
    inputFirstMsg.value = s.first_time_message || '';
  }).catch(() => {});
  setupModal.classList.add('active');
  setTimeout(() => inputServer.focus(), 200);
}

function closeModal() {
  setupModal.classList.remove('active');
}

btnEdit.addEventListener('click', openModal);
btnModalClose.addEventListener('click', closeModal);
btnModalCancel.addEventListener('click', closeModal);

// Close on backdrop click
setupModal.addEventListener('click', (e) => {
  if (e.target === setupModal) closeModal();
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && setupModal.classList.contains('active')) closeModal();
});

setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    ip: inputServer.value.trim(),
    username: inputUsername.value.trim(),
    password: inputPassword.value,
    first_time_message: inputFirstMsg.value.trim(),
  };
  if (!body.ip || !body.username) return;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Save failed');
    localStorage.setItem('cobelix-setup-done', '1');
    closeModal();
    // Reconnect with new settings
    socket.emit('command', 'save-reconnect');
  } catch (err) {
    console.error('Settings save error:', err);
  }
});

// ─── Tab Switching ───
let activeTab = 'console';

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    activeTab = tab;

    // Update buttons
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

    // Update content
    tabConsole.classList.toggle('active', tab === 'console');
    tabViewer.classList.toggle('active', tab === 'viewer');

    // When switching to console, scroll to bottom & unload viewer to free GPU
    if (tab === 'console') {
      if (autoScroll) {
        requestAnimationFrame(() => {
          consoleBody.scrollTop = consoleBody.scrollHeight;
        });
      }
      // Unload viewer iframe to save resources
      if (viewerIframe.src !== 'about:blank' && viewerIframe.src !== '') {
        viewerIframe.src = 'about:blank';
        if (viewerIsActive) viewerNeedsReload = true;
      }
    }
    // When switching to viewer, load iframe if needed
    if (tab === 'viewer' && viewerIsActive) {
      loadViewerIframe();
    }
  });
});

// ─── Viewer status ───
let viewerIsActive = false;

let viewerNeedsReload = false;

socket.on('viewer-status', (data) => {
  viewerIsActive = data.active;
  viewerDot.classList.toggle('live', data.active);

  if (data.active) {
    viewerNeedsReload = true;
    // Only load iframe if viewer tab is currently active
    if (activeTab === 'viewer') {
      loadViewerIframe();
    } else {
      // Prepare UI but don't load yet (lazy)
      viewerOffline.style.display = 'none';
      viewerIframe.style.display = 'none';
    }
  } else {
    viewerIframe.src = 'about:blank';
    viewerIframe.style.display = 'none';
    viewerOffline.style.display = 'flex';
    viewerNeedsReload = false;
  }
});

function loadViewerIframe() {
  if (!viewerNeedsReload) return;
  viewerNeedsReload = false;
  viewerIframe.src = 'about:blank';
  setTimeout(() => { viewerIframe.src = '/viewer/'; }, 100);
  viewerIframe.style.display = 'block';
  viewerOffline.style.display = 'none';
}

// First-run: ask server if setup is needed
(async function checkFirstRun() {
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    if (!s.needsSetup) {
      localStorage.setItem('cobelix-setup-done', '1');
      return;
    }
  } catch {}
  // Server says setup is needed — always show modal
  localStorage.removeItem('cobelix-setup-done');
  setTimeout(openModal, 500);
})();
