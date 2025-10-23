const $ = (sel) => document.querySelector(sel);

const authInfo = $("#auth-info");
const btnLogout = $("#btn-logout");

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

function initMap() {
  if (map) return; // avoid re-init
  // Initial center: Syracuse, NY (you can change it)
  map = L.map('map').setView([43.0481, -76.1474], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function renderOnMap(items) {
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

  if (latlngs.length > 0) {
    map.fitBounds(latlngs, { padding: [30, 30] });
  }
}

function getToken() { return localStorage.getItem("gc_token") || ""; }
function setToken(t) {
  if (t) localStorage.setItem("gc_token", t);
  else localStorage.removeItem("gc_token");
  renderAuthState();
}
function renderAuthState() {
  const t = getToken();
  authInfo.textContent = t ? "Logged in" : "Not logged in";
  btnLogout.style.display = t ? "inline-block" : "none";
}
btnLogout.addEventListener("click", () => setToken(""));

async function safeFetch(path, init = {}) {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", "Bearer " + token);
  return fetch(path, { ...init, headers });
}

function setMsg(el, text, ok = true) {
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

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
    renderOnMap(arr);
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
        <div><strong>${escapeHtml(p.user || "")}</strong></div>
        <div>${escapeHtml(p.message || "")}</div>
        <div>(${fmt(p.location?.lat)}, ${fmt(p.location?.lon)})</div>
      </div>`;
    results.appendChild(div);
  });
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
