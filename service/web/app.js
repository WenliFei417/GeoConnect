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

// === Map setup (Leaflet) ===
let map, markersLayer;
// Fit to bounds only once on first render; then respect user's zoom/pan
let allowFitOnce = true;

function initMap() {
  if (map) return; // avoid re-init
  // Initial center: Syracuse, NY (you can change it)
  map = L.map('map').setView([43.0481, -76.1474], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  // Auto refresh results when map view changes (debounced)
  map.on('moveend', debounce(viewportSearch, 400));
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
    // If this post belongs to the logged-in user and has an id, show Delete
    const currentUser = getCurrentUsername();
    if (currentUser && p.user === currentUser && p.id) {
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
    const res = await safeFetch(`/delete?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
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
