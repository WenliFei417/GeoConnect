const $ = (sel) => document.querySelector(sel);

const authInfo = $("#auth-info");
const btnLogout = $("#btn-logout");
const btnLoginLink = $("#btn-login-link");

const formSignup = $("#form-signup");
const signupMsg = $("#signup-msg");

const formLogin = $("#form-login");
const loginMsg = $("#login-msg");

const formPost = $("#form-post");
const postMsg = $("#post-msg");
const btnUseLoc = $("#btn-use-location");

const formSearch = $("#form-search");
const btnSearchMyLoc = $("#btn-search-my-loc");
const btnFillFromPost = $("#btn-fill-from-post");
const searchMsg = $("#search-msg");
const results = $("#results");
const selectState = $("#select-state");
const btnStateGo = $("#btn-state-go");

// === Map setup (Leaflet) ===
let map, markersLayer;
// Fit to bounds only once on first render; then respect user's zoom/pan
let allowFitOnce = true;
// 控制搜索并发与因手动跳转触发的自动搜索
let searchSeq = 0;               // 递增序号，防止旧响应覆盖新结果
let suppressNextViewport = false; // 手动移动（如跳州）时，抑制下一次 moveend 自动搜索

function initMap() {
  if (map) return; // avoid re-init
  // Initial center: Syracuse, NY (you can change it)
  map = L.map('map').setView([43.0481, -76.1474], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  // Auto refresh results when map view changes (debounced)
  const debouncedViewport = debounce(viewportSearch, 400);
  map.on('moveend', () => {
    if (suppressNextViewport) { suppressNextViewport = false; return; }
    debouncedViewport();
  });
  // Initial fetch for current view (if logged in)
  viewportSearch();
}

function renderOnMap(items, fit = true) {
  if (!document.getElementById('map')) return; // map section may not exist
  if (!map) initMap();
  markersLayer.clearLayers();
  if (!items || !items.length) return;

  const latlngs = [];
  items.forEach((p) => {
    const lat = Number(p?.location?.lat);
    const lon = Number(p?.location?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const popupHtml = `
      <div style="min-width:180px">
        <div><strong>${escapeHtml(p.user || "")}</strong></div>
        <div style="margin:4px 0">${escapeHtml(p.message || "")}</div>
        ${p.url ? `<img src="${escapeHtml(p.url)}" alt="img" style="width:100%;max-height:140px;object-fit:cover;border-radius:8px;border:1px solid #eee;" />` : ""}
        <div style="color:#666;margin-top:4px">(${fmt(lat)}, ${fmt(lon)})</div>
      </div>
    `;
    const marker = L.marker([lat, lon]).bindPopup(popupHtml);
    marker.addTo(markersLayer);
    latlngs.push([lat, lon]);
  });

  if (latlngs.length > 0 && fit) {
    map.fitBounds(latlngs, { padding: [30, 30] });
  }
}

// Query all posts within current map viewport and render
async function viewportSearch() {
  const seq = ++searchSeq;
  if (!map || !getToken()) return;
  try {
    const b = map.getBounds();
    const n = b.getNorth();
    const s = b.getSouth();
    const e = b.getEast();
    const w = b.getWest();
    setMsg(searchMsg, "Searching in current map view...");
    const url = `/search?mode=viewport&n=${n}&s=${s}&e=${e}&w=${w}&limit=500`;
    const res = await safeFetch(url);
    const txt = await res.text();
    if (!res.ok) { setMsg(searchMsg, "Search failed: " + txt, false); return; }
    let arr = []; try { arr = JSON.parse(txt) || []; } catch {}
    // 忽略过期响应（如果期间又发起了新的搜索）
    if (seq !== searchSeq) return;
    renderResults(arr);
    renderOnMap(arr, allowFitOnce);
    allowFitOnce = false;
    setMsg(searchMsg, `Found ${arr.length} result(s) in view.`, true);
  } catch (err) {
    setMsg(searchMsg, "Network error: " + err, false);
  }
}

function getToken() {
  return localStorage.getItem("token") || localStorage.getItem("gc_token") || "";
}
function setToken(t) {
  if (t) {
    localStorage.setItem("token", t);
    localStorage.setItem("gc_token", t);
  } else {
    localStorage.removeItem("token");
    localStorage.removeItem("gc_token");
  }
  renderAuthState();
}
function renderAuthState() {
  const t = getToken();
  authInfo.textContent = t ? "Logged in" : "Not logged in";
  if (btnLogout) btnLogout.style.display = t ? "inline-block" : "none";
  if (btnLoginLink) btnLoginLink.style.display = t ? "none" : "inline-block";
}
if (btnLogout) {
  btnLogout.addEventListener("click", () => {
    setToken("");
    window.location.href = "/auth.html";
  });
}

async function safeFetch(path, init = {}) {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", "Bearer " + token);
  return fetch(path, { ...init, headers });
}

// Simple debounce helper to avoid spamming the backend while panning/zooming
function debounce(fn, wait) {
  let t;
  return function(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// 美国本土各州（不含 AK/HI）边界（近似），用于按州搜索
const stateBounds = {
  AL:{n:35.0080,s:30.2233,e:-84.8882,w:-88.4732},
  AZ:{n:37.0043,s:31.3322,e:-109.0452,w:-114.8166},
  AR:{n:36.4996,s:33.0041,e:-89.6444,w:-94.6179},
  CA:{n:42.0095,s:32.5343,e:-114.1308,w:-124.4096},
  CO:{n:41.0034,s:36.9931,e:-102.0416,w:-109.0603},
  CT:{n:42.0506,s:41.2379,e:-71.7811,w:-73.7272},
  DE:{n:39.8395,s:38.4510,e:-75.0489,w:-75.7890},
  DC:{n:38.9955,s:38.7916,e:-76.9094,w:-77.1198},
  FL:{n:31.0000,s:24.3963,e:-80.0314,w:-87.6349},
  GA:{n:35.0007,s:30.3558,e:-80.8408,w:-85.6052},
  ID:{n:49.0011,s:41.9881,e:-111.0435,w:-117.2430},
  IL:{n:42.5083,s:36.9703,e:-87.4952,w:-91.5131},
  IN:{n:41.7606,s:37.7717,e:-84.7846,w:-88.0979},
  IA:{n:43.5012,s:40.3754,e:-90.1401,w:-96.6395},
  KS:{n:40.0032,s:36.9931,e:-94.5890,w:-102.0517},
  KY:{n:39.1474,s:36.4971,e:-81.9647,w:-89.5715},
  LA:{n:33.0195,s:28.8551,e:-89.0989,w:-94.0431},
  ME:{n:47.4597,s:43.0649,e:-66.9499,w:-71.0843},
  MD:{n:39.7220,s:37.9117,e:-75.0489,w:-79.4877},
  MA:{n:42.8866,s:41.1863,e:-69.8580,w:-73.5081},
  MI:{n:48.3061,s:41.6961,e:-82.4135,w:-90.4186},
  MN:{n:49.3845,s:43.4994,e:-89.4917,w:-97.2392},
  MS:{n:35.0059,s:30.1739,e:-88.0979,w:-91.6550},
  MO:{n:40.6136,s:35.9957,e:-89.0989,w:-95.7747},
  MT:{n:49.0011,s:44.3579,e:-104.0475,w:-116.0500},
  NE:{n:43.0017,s:39.9999,e:-95.3083,w:-104.0535},
  NV:{n:42.0022,s:35.0019,e:-114.0395,w:-120.0057},
  NH:{n:45.3055,s:42.6969,e:-70.6106,w:-72.5572},
  NJ:{n:41.3574,s:38.9286,e:-73.9024,w:-75.5636},
  NM:{n:37.0003,s:31.3323,e:-103.0020,w:-109.0502},
  NY:{n:45.0153,s:40.4961,e:-71.8562,w:-79.7624},
  NC:{n:36.5881,s:33.8423,e:-75.4563,w:-84.3219},
  ND:{n:49.0007,s:45.9351,e:-97.2287,w:-104.0489},
  OH:{n:41.9773,s:38.4034,e:-80.5187,w:-84.8203},
  OK:{n:37.0038,s:33.6158,e:-94.4311,w:-103.0026},
  OR:{n:46.2920,s:41.9918,e:-116.4635,w:-124.5662},
  PA:{n:42.5147,s:39.7199,e:-74.6895,w:-80.5199},
  RI:{n:42.0188,s:41.1463,e:-71.1206,w:-71.8628},
  SC:{n:35.2155,s:32.0335,e:-78.5408,w:-83.3533},
  SD:{n:45.9455,s:42.4797,e:-96.4366,w:-104.0577},
  TN:{n:36.6781,s:34.9829,e:-81.6469,w:-90.3103},
  TX:{n:36.5007,s:25.8371,e:-93.5083,w:-106.6456},
  UT:{n:42.0017,s:36.9980,e:-109.0415,w:-114.0530},
  VT:{n:45.0167,s:42.7303,e:-71.5102,w:-73.4397},
  VA:{n:39.4660,s:36.5408,e:-75.2423,w:-83.6753},
  WA:{n:49.0024,s:45.5435,e:-116.9156,w:-124.8489},
  WV:{n:40.6388,s:37.2015,e:-77.7190,w:-82.6447},
  WI:{n:47.3025,s:42.4919,e:-86.2496,w:-92.8894},
  WY:{n:45.0021,s:40.9948,e:-104.0522,w:-111.0569}
};

async function stateSearch(code) {
  if (!code || !stateBounds[code]) return;
  if (!getToken()) { setMsg(searchMsg, "Please log in first.", false); return; }
  if (!map) initMap();
  const b = stateBounds[code];
  const bounds = [[b.s, b.w],[b.n, b.e]];
  suppressNextViewport = true;      // 跳过因 fitBounds 触发的一次 moveend 自动搜索
  const seq = ++searchSeq;          // 将本次搜索标记为最新
  map.fitBounds(bounds, { padding: [30,30] });
  setMsg(searchMsg, `Searching in ${code}...`);
  try {
    const url = `/search?mode=viewport&n=${b.n}&s=${b.s}&e=${b.e}&w=${b.w}&limit=500`;
    const res = await safeFetch(url);
    const txt = await res.text();
    if (!res.ok) { setMsg(searchMsg, "Search failed: " + txt, false); return; }
    let arr = []; try { arr = JSON.parse(txt) || []; } catch {}
    if (seq !== searchSeq) return; // 忽略过期响应
    renderResults(arr);
    renderOnMap(arr, false);       // 已手动 fit 到州范围，这里不再自动 fit
    setMsg(searchMsg, `Found ${arr.length} result(s) in ${code}.`, true);
    allowFitOnce = false;          // 之后尊重用户缩放
  } catch (err) {
    setMsg(searchMsg, "Network error: " + err, false);
  }
}

// Decode JWT (without verification) to get current username for UI logic
function getCurrentUsername() {
  const t = getToken();
  if (!t || !t.includes('.')) return '';
  try {
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload && payload.username ? String(payload.username) : '';
  } catch {
    return '';
  }
}

// Decode JWT (without verification) to know if current user is admin
function getIsAdmin() {
  const t = getToken();
  if (!t || !t.includes('.')) return false;
  try {
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !!payload.is_admin;
  } catch {
    return false;
  }
}

function setMsg(el, text, ok = true) {
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

if (formSignup) {
  formSignup.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg(signupMsg, "Signing up...");
    const fd = new FormData(formSignup);
    const body = {
      username: fd.get("username"),
      password: fd.get("password"),
      age: Number(fd.get("age")),
      gender: fd.get("gender") || "unknown",
    };
    try {
      const res = await fetch("/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setMsg(signupMsg, "Signup failed: " + (await res.text()), false); return; }
      setMsg(signupMsg, "Signup successful. Please log in.", true);
      formSignup.reset();
    } catch (err) { setMsg(signupMsg, "Network error: " + err, false); }
  });
}

if (formLogin) {
  formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg(loginMsg, "Logging in...");
    const fd = new FormData(formLogin);
    const body = { username: fd.get("username"), password: fd.get("password") };
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setMsg(loginMsg, "Login failed: " + (await res.text()), false); return; }
      const data = await res.json().catch(async () => ({ token: await res.text() }));
      const token = data.token || data || "";
      if (!token) { setMsg(loginMsg, "No token returned.", false); return; }
      setToken(token);
      setMsg(loginMsg, "Login successful.", true);
      formLogin.reset();
      // Force clear in case the browser re-applies autofill right after reset
      formLogin.querySelectorAll('input').forEach(el => { el.value = ''; });
    } catch (err) { setMsg(loginMsg, "Network error: " + err, false); }
  });
}

btnUseLoc.addEventListener("click", async () => {
  const latInput = formPost.querySelector('input[name="lat"]');
  const lonInput = formPost.querySelector('input[name="lon"]');
  setMsg(postMsg, "Getting location...");
  try {
    const pos = await getCurrentPosition();
    latInput.value = pos.coords.latitude.toFixed(6);
    lonInput.value = pos.coords.longitude.toFixed(6);
    setMsg(postMsg, "Location filled.");
  } catch (e) { setMsg(postMsg, "Failed: " + e.message, false); }
});

formPost.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!getToken()) { setMsg(postMsg, "Please log in first.", false); return; }
  const fd = new FormData(formPost);
  try {
    const res = await safeFetch("/post", { method: "POST", body: fd });
    const txt = await res.text();
    if (!res.ok) { setMsg(postMsg, "Post failed: " + txt, false); return; }
    setMsg(postMsg, "Post successful.", true);
    formPost.reset();
  } catch (err) { setMsg(postMsg, "Network error: " + err, false); }
});

btnFillFromPost.addEventListener("click", () => {
  const lat = formPost.querySelector('input[name="lat"]').value;
  const lon = formPost.querySelector('input[name="lon"]').value;
  formSearch.querySelector('input[name="lat"]').value = lat;
  formSearch.querySelector('input[name="lon"]').value = lon;
  setMsg(searchMsg, "Copied coordinates.");
});

btnSearchMyLoc.addEventListener("click", async () => {
  setMsg(searchMsg, "Getting location...");
  try {
    const pos = await getCurrentPosition();
    formSearch.querySelector('input[name="lat"]').value = pos.coords.latitude.toFixed(6);
    formSearch.querySelector('input[name="lon"]').value = pos.coords.longitude.toFixed(6);
    setMsg(searchMsg, "Location filled.");
    if (typeof initMap === 'function') { initMap(); map && map.flyTo([Number(formSearch.querySelector('input[name="lat"]').value), Number(formSearch.querySelector('input[name="lon"]').value)], 13); }
    setTimeout(() => { viewportSearch(); }, 450);
  } catch (e) { setMsg(searchMsg, "Failed: " + e.message, false); }
});

if (btnStateGo) {
  btnStateGo.addEventListener("click", () => {
    const code = (selectState && selectState.value) || "";
    stateSearch(code);
  });
}
if (selectState) {
  selectState.addEventListener("change", () => {
    if (selectState.value) stateSearch(selectState.value);
  });
}

formSearch.addEventListener("submit", async (e) => {
  e.preventDefault();
  results.innerHTML = "";
  if (!getToken()) { setMsg(searchMsg, "Please log in first.", false); return; }
  const fd = new FormData(formSearch);
  const lat = fd.get("lat"), lon = fd.get("lon"), range = fd.get("range");
  setMsg(searchMsg, "Searching...");
  try {
    const res = await safeFetch(`/search?lat=${lat}&lon=${lon}&range=${range}`);
    const txt = await res.text();
    if (!res.ok) { setMsg(searchMsg, "Search failed: " + txt, false); return; }
    let arr = []; try { arr = JSON.parse(txt) || []; } catch {}
    renderResults(arr);
    renderOnMap(arr, true);
    setMsg(searchMsg, `Found ${arr.length} result(s).`, true);
  } catch (err) { setMsg(searchMsg, "Network error: " + err, false); }
});

function renderResults(items) {
  results.innerHTML = "";
  items.forEach((p) => {
    const div = document.createElement("div");
    div.className = "card-result";
    const imgHtml = p.url ? `<img src="${escapeHtml(p.url)}" alt="image" />` : "";
    div.innerHTML = `${imgHtml}
      <div class="result-meta">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <strong>${escapeHtml(p.user || "")}</strong>
          <span style="font-size:12px;color:#888;">${p.id ? escapeHtml(p.id) : ''}</span>
        </div>
        <div>${escapeHtml(p.message || "")}</div>
        <div>(${fmt(p.location?.lat)}, ${fmt(p.location?.lon)})</div>
        <div class="actions"></div>
      </div>`;
    results.appendChild(div);
    // If this post belongs to the logged-in user or user is admin, and has an id, show Delete
    const currentUser = getCurrentUsername();
    const isAdmin = getIsAdmin();
    if (p.id && ((currentUser && p.user === currentUser) || isAdmin)) {
      const actions = div.querySelector('.actions');
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.style.marginTop = '6px';
      delBtn.addEventListener('click', async () => {
        await deletePost(p.id, div, delBtn);
      });
      actions.appendChild(delBtn);
    }
  });
}

async function deletePost(id, cardEl, btnEl) {
  if (!getToken()) { alert('Please log in first.'); return; }
  try {
    btnEl.disabled = true;
    btnEl.textContent = 'Deleting...';
    const res = await safeFetch(`/post`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const txt = await res.text();
    if (!res.ok) {
      btnEl.disabled = false;
      btnEl.textContent = 'Delete';
      alert('Delete failed: ' + txt);
      return;
    }
    // Remove the card from UI
    if (cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
    // Refresh map by running the current search again if formSearch exists
    if (formSearch) {
      const lat = formSearch.querySelector('input[name="lat"]')?.value || '';
      const lon = formSearch.querySelector('input[name="lon"]')?.value || '';
      const range = formSearch.querySelector('input[name="range"]')?.value || '200';
      if (lat && lon) {
        try {
          const r = await safeFetch(`/search?lat=${lat}&lon=${lon}&range=${range}`);
          const t = await r.text();
          if (r.ok) {
            let arr = []; try { arr = JSON.parse(t) || []; } catch {}
            // Re-render list and map after deletion
            renderResults(arr);
            renderOnMap(arr, false);
            setMsg(searchMsg, `Found ${arr.length} result(s).`, true);
          }
        } catch {}
      }
    }
  } catch (e) {
    alert('Network error: ' + e);
    btnEl.disabled = false;
    btnEl.textContent = 'Delete';
  }
}

function fmt(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(5) : ""; }
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  });
}
function escapeHtml(s) {
  return String(s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
renderAuthState();

// Auto-init map on page load if the container exists.
document.addEventListener("DOMContentLoaded", () => {
  const hasMap = document.getElementById("map");
  if (hasMap && typeof initMap === "function") {
    try { initMap(); } catch (e) { console.error("Map init error:", e); }
  }
});
