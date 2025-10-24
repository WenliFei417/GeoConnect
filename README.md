# 🌍 GeoConnect — Location-Based Social Posting & Search Platform (Go Backend)

**Live Demo:** [https://geoconnect-475801.uc.r.appspot.com](https://geoconnect-475801.uc.r.appspot.com)

**GeoConnect** is a **location-based mini social network** where users can **sign up, log in, post messages with images and geolocation**, and **search for nearby posts** on a map.  
It provides a RESTful backend service implemented in **Go**, powered by **Elasticsearch** for geo-search and **Google Cloud Storage (GCS)** or local storage for media uploads.  
This project is designed for **course projects or small-scale demos**, and can be deployed directly on **Google App Engine**.

---

## 🧩 Tech Stack

- **Language:** Go (tested with Go 1.22+; `app.yaml` uses `runtime: go122`)
- **Search & Geo:** Elasticsearch 7.x (`github.com/olivere/elastic/v7`)
- **Auth:** JWT (`github.com/golang-jwt/jwt`, HS256)
- **Password Hashing:** bcrypt (`golang.org/x/crypto/bcrypt`)
- **Storage:** Google Cloud Storage (GCS) or local directory
- **Deployment:** Google App Engine (Standard)

---

## 📁 Project Structure (Partial)

```
service/
  main.go
  user.go
  app.yaml
  go.mod
  go.sum
  uploads/
  ...
```

> Key files:
> - `main.go`: registers routes, handles JWT auth, posting/search/deletion, and storage (GCS or local)
> - `user.go`: handles `/signup` and `/login`, bcrypt password hashing, and JWT generation
> - `app.yaml`: App Engine configuration (runtime, env vars, etc.)

---

## ⚙️ Prerequisites

1. **Go** 1.22 or higher  
2. **Elasticsearch 7.x** (local or cloud)  
3. **Google Cloud Storage (optional)** – can be disabled to use local storage

---

## 🔧 Environment Variables

From `app.yaml`:

| Variable | Description | Example |
|-----------|--------------|----------|
| `GCS_BUCKET` | GCS bucket name for uploads | `post-images-geoconnect-475801` |
| `ADMIN_USERS` | Comma-separated list of admin usernames | `"kimi,alice,bob"` |
| `USE_GCS` | Set to `"0"` to disable GCS and use local uploads | `"0"` |
| `LOCAL_UPLOAD_DIR` | Local upload directory | `uploads` |
| `PORT` | Local port (default 8080) | `8080` |

⚠️ **Important**
- JWT secret is currently hardcoded as `secret` (`var mySigningKey = []byte("secret")`).  
  ➜ Replace it with a secure random key and load from an environment variable (`JWT_SECRET`) in production.  
- Elasticsearch URL is hardcoded in `main.go`:  
  ```go
  const ES_URL = "http://34.44.14.36:9200"
  ```
  ➜ Update it to your own ES instance before deployment.

---

## 🚀 Run Locally

```bash
# Go to backend directory
cd service

# Optional: set env vars
export USE_GCS=0
export LOCAL_UPLOAD_DIR=uploads
export ADMIN_USERS="kimi"

# Run (make sure ES is running and accessible)
go run main.go
```

On startup, the service will:
- Connect to Elasticsearch
- Create indexes (`posts`, `users`) if not present
- Load admin users from `ADMIN_USERS` into memory (`adminSet`)

---

## 🧠 API Overview

All endpoints return JSON.  
Only `/signup` and `/login` are public — others require a valid JWT.

### 1️⃣ **Signup** — `POST /signup`
**Request body:**
```json
{"username": "kimi", "password": "123456", "gender": "female", "age": 20}
```

- Username must match `^[a-z0-9_]+$`
- Password stored as bcrypt hash in ES
- Existing usernames are rejected

**Response:**
```json
{"status": "ok"}
```

---

### 2️⃣ **Login** — `POST /login`
**Request body:**
```json
{"username": "kimi", "password": "123456"}
```

- Returns JWT token with `username`, `is_admin`, and 24-hour expiration.

**Response:**
```json
{"token": "<jwt-token>"}
```

> Use the token directly in header:  
> `Authorization: <token>` (no `Bearer` prefix)

---

### 3️⃣ **Post** — `POST /post` (JWT required)
Supports two formats:
1. `multipart/form-data` (for image upload)
   - Fields: `message`, `lat`, `lon`, `image`
2. `application/json`
   - Example:
     ```json
     {"message":"hi","location":{"lat":43.0,"lon":-76.1}}
     ```

Behavior:
- If `USE_GCS != "0"` and `GCS_BUCKET` is set, uploads image to GCS (public URL).  
  Otherwise, saves locally under `/uploads/`.
- Filters sensitive words.
- Saves post to Elasticsearch `posts` index (with geolocation).

**Response:**
```json
{"status":"ok"}
```

---

### 4️⃣ **Search** — `GET /search` (JWT required)
**Query params:**
- `lat`, `lon` (required)
- `limit` (optional, default 200, max 1000)
- `range` (optional, e.g. `200km`)
- `mode` (optional, e.g. `viewport`)

**Response:**
```json
[
  {
    "id": "<es-doc-id>",
    "user": "kimi",
    "message": "hi",
    "location": {"lat": 43.0, "lon": -76.1},
    "url": "https://..."
  }
]
```

---

### 5️⃣ **Delete** — `/delete` (JWT required)
Only **post author** or **admin** can delete posts.  
Supports two input formats:

- `GET /delete?id=<es-doc-id>`
- `POST /delete`
  ```json
  {"id": "<es-doc-id>"}
  ```

**Response:**
```json
{"status":"deleted"}
```

---

## ☁️ Deploying to Google App Engine

1. Update `app.yaml`:
   ```yaml
   runtime: go122
   instance_class: F1
   env_variables:
     GCS_BUCKET: "your-gcs-bucket"
     ADMIN_USERS: "kimi"
   handlers:
     - url: /.*
       script: auto
   ```
2. Authenticate and set project:
   ```bash
   gcloud auth login
   gcloud config set project <your-project-id>
   ```
3. Deploy:
   ```bash
   cd service
   gcloud app deploy
   ```

> ⚠️ If using local uploads (`USE_GCS=0`), ensure write permissions in App Engine.  
> GCS is recommended for production.

---

## 🪪 License

This project was created for educational use.  
If open-sourced, consider adding an MIT or Apache-2.0 license.

---

**Author:** Wenli Fei (GeoConnect)
