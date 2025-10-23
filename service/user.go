package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/olivere/elastic/v7"
	"golang.org/x/crypto/bcrypt"
)

// 与 main.go 中的 USERS_INDEX 常量相对应：users 索引用于存用户
// main.go 里已经有：const USERS_INDEX = "users"

// User 表示注册用户（密码以哈希形式存储）
type User struct {
	Username string `json:"username"`
	Password string `json:"password"` // 存储的是 bcrypt 哈希，不是明文
	Age      int    `json:"age"`
	Gender   string `json:"gender"`
}

// 仅允许小写字母、数字、下划线
var usernamePattern = regexp.MustCompile(`^[a-z0-9_]+$`).MatchString

// signupHandler：注册新用户 → 校验用户名规则与重复 → bcrypt 哈希 → 写入 ES
func signupHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var in User
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	// 基础校验
	if !usernamePattern(in.Username) {
		http.Error(w, "invalid username", http.StatusBadRequest)
		return
	}
	if in.Password == "" {
		http.Error(w, "password required", http.StatusBadRequest)
		return
	}

	// 连接 ES
	esClient, err := elastic.NewClient(
		elastic.SetURL(ES_URL),
		elastic.SetSniff(false),
	)
	if err != nil {
		http.Error(w, "es not available", http.StatusInternalServerError)
		return
	}

	// 用户名唯一性检查（按 ID）
	getResp, err := esClient.Get().Index(USERS_INDEX).Id(in.Username).Do(r.Context())
	if err == nil && getResp.Found {
		http.Error(w, "username already exists", http.StatusConflict)
		return
	}

	// 生成 bcrypt 哈希
	hashed, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		http.Error(w, "hash failed", http.StatusInternalServerError)
		return
	}
	in.Password = string(hashed)

	// 写入 ES：用 username 作为文档 ID，避免重复
	_, err = esClient.Index().
		Index(USERS_INDEX).
		Id(in.Username).
		BodyJson(in).
		Refresh("true"). // 测试期立即可见
		Do(r.Context())
	if err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// loginHandler：基于 ES 的登录：读取用户名密码 → 查 ES → 校验 bcrypt → 返回 JWT
func loginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var creds struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&creds); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if creds.Username == "" || creds.Password == "" {
		http.Error(w, "username/password required", http.StatusBadRequest)
		return
	}

	// 连接 ES
	esClient, err := elastic.NewClient(
		elastic.SetURL(ES_URL),
		elastic.SetSniff(false),
	)
	if err != nil {
		http.Error(w, "es not available", http.StatusInternalServerError)
		return
	}

	// 读取用户（先按 ID，再回退 term 查询，兼容性更好）
	var u User
	getResp, err := esClient.Get().Index(USERS_INDEX).Id(creds.Username).Do(r.Context())
	if err == nil && getResp.Found {
		if err := json.Unmarshal(getResp.Source, &u); err != nil {
			http.Error(w, "decode user failed", http.StatusInternalServerError)
			return
		}
	} else {
		term := elastic.NewTermQuery("username", creds.Username)
		sr, err := esClient.Search().Index(USERS_INDEX).Query(term).Size(1).Do(r.Context())
		if err != nil || sr.Hits.TotalHits.Value == 0 {
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		if err := json.Unmarshal(sr.Hits.Hits[0].Source, &u); err != nil {
			http.Error(w, "decode user failed", http.StatusInternalServerError)
			return
		}
	}

	// 校验密码（bcrypt）
	if err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(creds.Password)); err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	// 签发 JWT（使用 main.go 里的 generateToken）
	tokenString, err := generateToken(u.Username)
	if err != nil {
		http.Error(w, "cannot mint token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"token": tokenString})
}
