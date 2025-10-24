function setMsg(el, text, ok = false) {
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "green" : "red";
}

function getBase() {
  return "";
}

async function safeFetch(path, init = {}) {
  const token = localStorage.getItem("token");
  const headers = init.headers || {};
  if (token) headers.Authorization = `Bearer ${token}`;
  headers["Content-Type"] = headers["Content-Type"] || "application/json";
  return fetch(getBase() + path, { ...init, headers });
}

// Login form
const formLogin = document.querySelector("#form-login");
if (formLogin) {
  formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.querySelector("#login-msg");
    const data = Object.fromEntries(new FormData(formLogin).entries());
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const txt = await res.text();
      if (!res.ok) return setMsg(msg, txt);
      const json = JSON.parse(txt);
      localStorage.setItem("token", json.token);
      setMsg(msg, "Login success!", true);
      setTimeout(() => (window.location = "/"), 800);
    } catch (err) {
      setMsg(msg, "Network error: " + err);
    }
  });
}

// Signup form
const formSignup = document.querySelector("#form-signup");
if (formSignup) {
  formSignup.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.querySelector("#signup-msg");
    const data = Object.fromEntries(new FormData(formSignup).entries());
    try {
      const res = await fetch("/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const txt = await res.text();
      if (!res.ok) return setMsg(msg, txt);
      setMsg(msg, "Sign up success! Please login.", true);
      formSignup.reset();
    } catch (err) {
      setMsg(msg, "Network error: " + err);
    }
  });
}