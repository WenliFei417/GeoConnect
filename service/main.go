package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	// 导入Elasticsearch官方Go客户端
	"cloud.google.com/go/storage"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/olivere/elastic/v7"
)

// Location 结构体表示地理位置，包含纬度和经度
type Location struct {
	Lat float64 `json:"lat"` // 纬度
	Lon float64 `json:"lon"` // 经度
}

// Post 结构体表示一条用户发的帖子，包含用户名、消息和地理位置
type Post struct {
	User     string   `json:"user"`          // 用户名
	Message  string   `json:"message"`       // 帖子内容
	Location Location `json:"location"`      // 帖子对应的地理位置
	Url      string   `json:"url,omitempty"` // 图片在GCS中的公开访问地址
}

// PostWithID 用于在搜索响应中携带 ES 文档 ID（便于前端删除等操作）。
type PostWithID struct {
	ID string `json:"id"`
	Post
}

const (
	// ES_URL 是Elasticsearch服务器的地址
	ES_URL = "http://34.44.14.36:9200"
	// INDEX 是ES中存储帖子数据的索引名称
	INDEX = "posts"
	// DISTANCE 是默认的搜索距离范围，单位为公里
	DISTANCE = "200km"
	// 你的 GCS 存储桶名称（Bucket 名），用于保存用户上传的图片
	BUCKET_NAME = "post-images-geoconnect-475801"
	USERS_INDEX = "users"
)

var (
	// If USE_GCS is "0", we will save uploads to local disk instead of GCS.
	useGCS = os.Getenv("USE_GCS") != "0"
	// Local upload directory when useGCS is false.
	localUploadDir = getenvDefault("LOCAL_UPLOAD_DIR", "uploads")
)

// --- 管理员（超级用户）支持 ---
// adminSet 保存从环境变量 ADMIN_USERS（逗号分隔）加载的管理员用户名（统一转为小写）
var adminSet = map[string]bool{}

func isAdminUsername(u string) bool {
	u = strings.ToLower(strings.TrimSpace(u))
	if u == "" {
		return false
	}
	return adminSet[u]
}

// 从 Context 读取管理员标记
func isAdminFromCtx(ctx context.Context) bool {
	if v := ctx.Value("is_admin"); v != nil {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

// getenvDefault：若环境变量存在则返回其值，否则返回默认值
func getenvDefault(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// =====================
// 简化版 JWT 示例（课程项目）
// =====================

// 定义签名秘钥（生产环境应改为安全的随机字符串）
var mySigningKey = []byte("secret")

// generateToken：根据用户名生成 JWT，过期时间 24 小时；并携带 is_admin 声明
func generateToken(username string) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"username": username,
		"is_admin": isAdminUsername(username),
		"exp":      time.Now().Add(24 * time.Hour).Unix(), // 24 小时有效期
	})
	return token.SignedString(mySigningKey)
}

// jwtRequired：检查请求头中的 Authorization 是否带有有效的 JWT
func jwtRequired(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenString := r.Header.Get("Authorization")
		if !strings.HasPrefix(tokenString, "Bearer ") {
			http.Error(w, "Missing token", http.StatusUnauthorized)
			return
		}
		tokenString = strings.TrimPrefix(tokenString, "Bearer ")

		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			return mySigningKey, nil
		})
		if err != nil || !token.Valid {
			http.Error(w, "Invalid token", http.StatusUnauthorized)
			return
		}

		// 从 JWT 提取用户名与 is_admin 并写入 Context
		var username string
		var isAdmin bool
		if claims, ok := token.Claims.(jwt.MapClaims); ok && token.Valid {
			if v, ok := claims["username"].(string); ok {
				username = v
			}
			// 兼容 bool 或字符串
			if vb, ok := claims["is_admin"].(bool); ok {
				isAdmin = vb
			} else if vs, ok := claims["is_admin"].(string); ok && strings.ToLower(vs) == "true" {
				isAdmin = true
			}
		}
		ctx := context.WithValue(r.Context(), "username", username)
		ctx = context.WithValue(ctx, "is_admin", isAdmin)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

// usernameFromCtx 读取在 jwtRequired 中注入的用户名；若不存在返回空字符串
func usernameFromCtx(ctx context.Context) string {
	if v := ctx.Value("username"); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// containsFilteredWords 用于检测字符串中是否包含禁用词
// 若包含，返回 true；否则返回 false
func containsFilteredWords(s *string) bool {
	filteredWords := []string{"spam", "advertisement", "politics"}
	for _, word := range filteredWords {
		if strings.Contains(strings.ToLower(*s), word) {
			return true
		}
	}
	return false
}

// saveToES 用于保存帖子到Elasticsearch
func saveToES(p *Post, id string) error {
	// 创建ES客户端（连接URL并关闭嗅探）
	esClient, err := elastic.NewClient(
		elastic.SetURL(ES_URL),
		elastic.SetSniff(false),
	)
	if err != nil {
		return err
	}

	// 写入索引（指定index与id，body为帖子内容）
	_, err = esClient.Index().
		Index(INDEX).
		Id(id).
		BodyJson(p).
		Refresh("true"). // 立即可见，便于测试；生产可去掉或用"wait_for"
		Do(context.Background())
	if err != nil {
		return err
	}

	fmt.Printf("Post is saved to index=%s, id=%s, message=%s\n", INDEX, id, p.Message)
	return nil
}

// saveToGCS 将上传的文件写入到指定的 GCS 存储桶，并返回可公开访问的 URL。
// 课堂/练习的最简单做法是假设 Bucket 已设置为 public-read（Uniform 访问控制 + allUsers: Storage Object Viewer）。
func saveToGCS(ctx context.Context, bucket string, r io.Reader, originalName string) (string, error) {
	// 创建 GCS 客户端
	client, err := storage.NewClient(ctx)
	if err != nil {
		return "", err
	}
	defer client.Close()

	// 生成对象名：使用 uuid + 原文件扩展名，避免重名覆盖
	ext := strings.ToLower(filepath.Ext(originalName))
	objName := uuid.New().String() + ext

	obj := client.Bucket(bucket).Object(objName)
	w := obj.NewWriter(ctx)

	// 设置Content-Type（根据扩展名推断），便于浏览器正确展示
	if ct := mime.TypeByExtension(ext); ct != "" {
		w.ContentType = ct
	}
	// 可选：为静态资源设置缓存策略
	// w.CacheControl = "public, max-age=31536000"

	// 写入对象数据
	if _, err := io.Copy(w, r); err != nil {
		_ = w.Close()
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}

	// 返回公开访问的 URL（适用于 public-read 桶）
	return fmt.Sprintf("https://storage.googleapis.com/%s/%s", bucket, objName), nil
}

/*
saveToLocal：在本地测试时将上传文件保存到本地目录，
并返回可由 Go 静态文件服务访问的 URL 路径，例如 "/uploads/<文件名>"。
*/
func saveToLocal(ctx context.Context, dir string, r io.Reader, originalName string) (string, error) {
	ext := strings.ToLower(filepath.Ext(originalName))
	if ext == "" {
		ext = ".bin"
	}
	objName := uuid.New().String() + ext

	// Ensure directory exists
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	dstPath := filepath.Join(dir, objName)
	f, err := os.Create(dstPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	if _, err := io.Copy(f, r); err != nil {
		return "", err
	}

	// Return the public path (served in main() when useGCS == false)
	return "/uploads/" + objName, nil
}

// handlerSearch 处理搜索请求
func handlerSearch(w http.ResponseWriter, r *http.Request) {
	fmt.Println("Received one request for search")

	lat, _ := strconv.ParseFloat(r.URL.Query().Get("lat"), 64) // 解析纬度参数
	lon, _ := strconv.ParseFloat(r.URL.Query().Get("lon"), 64) // 解析经度参数

	mode := strings.ToLower(r.URL.Query().Get("mode"))
	// Optional max results (default 200, cap 1000)
	size := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			if n < 1 {
				size = 1
			} else if n > 1000 {
				size = 1000
			} else {
				size = n
			}
		}
	}

	ran := DISTANCE
	if val := r.URL.Query().Get("range"); val != "" {
		ran = val + "km" // 解析搜索范围参数
	}

	fmt.Printf("Search received: %f %f %s\n", lat, lon, ran)

	// 创建ES客户端（连接到指定URL并关闭嗅探功能）
	client, err := elastic.NewClient(
		elastic.SetURL(ES_URL),
		elastic.SetSniff(false),
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 根据模式构建查询：
	// 1) 默认圆形半径模式（lat/lon/range）
	// 2) 视野模式（mode=viewport + n/s/e/w）使用 geo_bounding_box
	var q elastic.Query
	if mode == "viewport" {
		// 读取四至（北 South 东 West）
		north, errN := strconv.ParseFloat(r.URL.Query().Get("n"), 64)
		south, errS := strconv.ParseFloat(r.URL.Query().Get("s"), 64)
		east, errE := strconv.ParseFloat(r.URL.Query().Get("e"), 64)
		west, errW := strconv.ParseFloat(r.URL.Query().Get("w"), 64)
		if errN != nil || errS != nil || errE != nil || errW != nil {
			http.Error(w, "invalid viewport bounds (n/s/e/w)", http.StatusBadRequest)
			return
		}
		q = elastic.NewGeoBoundingBoxQuery("location").
			TopLeft(north, west).
			BottomRight(south, east)
	} else {
		// 默认圆形距离查询
		q = elastic.NewGeoDistanceQuery("location").
			Distance(ran).
			Lat(lat).
			Lon(lon)
	}

	// 执行搜索请求（在指定索引中执行查询）
	res, err := client.Search().
		Index(INDEX).
		Query(q).
		Size(size).
		Pretty(true).
		Do(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	fmt.Printf("Query took %d ms, total hits %d\n", res.TookInMillis, res.TotalHits())

	var out []PostWithID
	// 遍历搜索结果，带上每条文档的 ES ID
	for _, hit := range res.Hits.Hits {
		var p Post
		if err := json.Unmarshal(hit.Source, &p); err == nil {
			out = append(out, PostWithID{
				ID:   hit.Id,
				Post: p,
			})
		}
	}

	// 将结果编码为JSON
	b, err := json.Marshal(out)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 设置响应头并返回结果
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write(b)
}

// handlerPost 处理发帖请求
func handlerPost(w http.ResponseWriter, r *http.Request) {

	fmt.Println("Received one post request")

	// 支持两种请求格式：
	// 1) multipart/form-data（表单 + 文件上传）
	// 2) application/json（原有 JSON 请求）
	contentType := r.Header.Get("Content-Type")
	var p Post
	username := usernameFromCtx(r.Context())
	if username == "" {
		http.Error(w, "missing user in context", http.StatusUnauthorized)
		return
	}
	if strings.Contains(strings.ToLower(contentType), "multipart/form-data") {
		// --- 处理文件表单上传 ---
		// 解析 multipart 表单：32MB 内存阈值，超过部分写入临时文件
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			log.Printf("parse multipart failed: %v", err) // minimal: log details to help debugging
			http.Error(w, "invalid multipart form", http.StatusBadRequest)
			return
		}

		// 从表单获取文本字段
		lat, _ := strconv.ParseFloat(r.FormValue("lat"), 64)
		lon, _ := strconv.ParseFloat(r.FormValue("lon"), 64)
		p = Post{
			User:    username,
			Message: r.FormValue("message"),
			Location: Location{
				Lat: lat,
				Lon: lon,
			},
		}

		// 从表单获取文件字段：key = "image"（可选）
		file, hdr, err := r.FormFile("image")
		if err == nil && file != nil {
			defer file.Close()
			if useGCS {
				// 上传到 GCS
				url, err := saveToGCS(r.Context(), BUCKET_NAME, file, hdr.Filename)
				if err != nil {
					log.Printf("GCS upload error: %v", err)
					http.Error(w, "upload to GCS failed", http.StatusInternalServerError)
					return
				}
				p.Url = url
			} else {
				// 保存到本地目录，返回可访问的相对路径
				url, err := saveToLocal(r.Context(), localUploadDir, file, hdr.Filename)
				if err != nil {
					log.Printf("local upload error: %v", err)
					http.Error(w, "upload to local failed", http.StatusInternalServerError)
					return
				}
				p.Url = url
			}
		} else {
			// 没有图片也允许发帖
			log.Printf("no image provided in multipart form; continuing without image")
		}
	} else {
		// --- 处理原有 JSON 请求 ---
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&p); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		p.User = username
	}

	// 检查帖子内容是否包含禁用词（如广告、政治内容等）
	if containsFilteredWords(&p.Message) {
		http.Error(w, "message contains forbidden words", http.StatusBadRequest)
		return
	}

	// 生成唯一ID（用于ES文档ID）
	id := uuid.New().String()

	// 保存到ES（写入posts索引）
	if err := saveToES(&p, id); err != nil {
		http.Error(w, "failed to save to ES: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// 返回简单JSON结果（告知前端已保存）
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// handlerDeletePost 仅允许作者本人或管理员删除帖子
func handlerDeletePost(w http.ResponseWriter, r *http.Request) {
	username := usernameFromCtx(r.Context())
	if username == "" {
		http.Error(w, "missing user in context", http.StatusUnauthorized)
		return
	}

	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	// 创建 ES 客户端
	client, err := elastic.NewClient(
		elastic.SetURL(ES_URL),
		elastic.SetSniff(false),
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 先取文档，验证是否作者本人或管理员
	getResp, err := client.Get().Index(INDEX).Id(id).Do(r.Context())
	if err != nil || !getResp.Found {
		http.Error(w, "post not found", http.StatusNotFound)
		return
	}
	var p Post
	if err := json.Unmarshal(getResp.Source, &p); err != nil {
		http.Error(w, "failed to parse post", http.StatusInternalServerError)
		return
	}
	if p.User != username && !isAdminFromCtx(r.Context()) {
		http.Error(w, "forbidden: not the owner or admin", http.StatusForbidden)
		return
	}

	// 通过验证后执行删除
	if _, err := client.Delete().Index(INDEX).Id(id).Do(r.Context()); err != nil {
		http.Error(w, "delete failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(`{"status":"deleted"}`))
}

func main() {
	// 创建ES客户端（连接到指定URL并关闭嗅探功能）
	client, err := elastic.NewClient(
		elastic.SetURL(ES_URL),
		elastic.SetSniff(false),
	)
	if err != nil {
		log.Fatalf("failed to create ES client: %v", err)
		return
	}

	// 从环境变量 ADMIN_USERS（逗号分隔的用户名）加载管理员列表到 adminSet
	if admins := os.Getenv("ADMIN_USERS"); admins != "" {
		for _, u := range strings.Split(admins, ",") {
			s := strings.ToLower(strings.TrimSpace(u))
			if s != "" {
				adminSet[s] = true
			}
		}
		log.Printf("admin users loaded: %v", adminSet)
	} else {
		log.Printf("no ADMIN_USERS set; no superuser configured")
	}

	// Step 2/3: 确保用户索引存在（用于注册/登录）
	usersExists, err := client.IndexExists(USERS_INDEX).Do(context.Background())
	if err != nil {
		log.Fatalf("failed to check users index existence: %v", err)
		return
	}
	if !usersExists {
		usersMapping := `{
			"mappings": {
				"properties": {
					"username": { "type": "keyword" },
					"password": { "type": "keyword" },
					"age":      { "type": "integer" },
					"gender":   { "type": "keyword" }
				}
			}
		}`
		if _, err := client.CreateIndex(USERS_INDEX).BodyString(usersMapping).Do(context.Background()); err != nil {
			log.Fatalf("failed to create users index %q: %v", USERS_INDEX, err)
			return
		}
	}

	// 查询ES索引是否存在（返回true或false）
	exists, err := client.IndexExists(INDEX).Do(context.Background())
	if err != nil {
		log.Fatalf("failed to check index existence: %v", err)
		return
	}

	if !exists {
		// 如果索引不存在，定义索引的mapping（数据结构）
		// mapping中"user"字段类型为keyword，适合精确匹配和聚合
		// "message"字段类型为text，适合全文搜索
		// "location"字段类型为geo_point，支持地理位置查询
		mapping := `{
			"mappings": {
				"properties": {
					"user":     { "type": "keyword" },
					"message":  { "type": "text"    },
					"location": { "type": "geo_point" }
				}
			}
		}`

		// 使用定义好的mapping创建ES索引
		createResp, err := client.CreateIndex(INDEX).
			BodyString(mapping).
			Do(context.Background())
		if err != nil {
			log.Fatalf("failed to create index %q: %v", INDEX, err)
			return
		}
		if !createResp.Acknowledged {
			log.Printf("warning: create index %q not acknowledged by ES", INDEX)
		}
	}

	// 启动HTTP服务并注册路由
	fmt.Println("started-service")
	// 静态前端：将根路径 "/" 指向 web/ 目录，直接服务 index.html、styles.css、app.js 等文件
	// 说明：Go 的路由是“最长前缀优先”。我们对 /signup、/login、/post、/search 都注册了更具体的路径，
	// 所以它们会优先匹配，不会被下面的 "/" 静态路由覆盖；只有其他未匹配的路径才会落到静态文件。
	fs := http.FileServer(http.Dir("web"))
	http.Handle("/", fs)

	// 本地运行（USE_GCS=0）时，从 /uploads/ 路径提供已上传文件
	if !useGCS {
		// 将 URL 路径 /uploads/ 映射到磁盘目录 localUploadDir
		http.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(localUploadDir))))
		log.Printf("local upload dir enabled: serving %q at /uploads/", localUploadDir)
	}

	http.HandleFunc("/login", loginHandler)
	http.HandleFunc("/signup", signupHandler)
	// Step 1: 使用 JWT 中间件保护 /post 与 /search 与 /delete
	http.HandleFunc("/post", jwtRequired(handlerPost))
	http.HandleFunc("/search", jwtRequired(handlerSearch))
	http.HandleFunc("/delete", jwtRequired(handlerDeletePost))
	// 监听端口：若平台提供 PORT 环境变量则使用，否则本地默认 8080
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
