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
	"reflect"
	"strconv"
	"strings"

	// 导入Elasticsearch官方Go客户端
	"cloud.google.com/go/storage"
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

const (
	// ES_URL 是Elasticsearch服务器的地址
	ES_URL = "http://34.44.14.36:9200"
	// INDEX 是ES中存储帖子数据的索引名称
	INDEX = "posts"
	// DISTANCE 是默认的搜索距离范围，单位为公里
	DISTANCE = "200km"
	// 你的 GCS 存储桶名称（Bucket 名），用于保存用户上传的图片
	BUCKET_NAME = "post-images-geoconnect-475801"
)

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
	// minimal root route so opening the domain won’t 404
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("GeoConnect is running. POST /post or GET /search?lat=...&lon=..."))
	})
	http.HandleFunc("/post", handlerPost)     // 注册发帖处理函数
	http.HandleFunc("/search", handlerSearch) // 注册搜索处理函数
	// listen on PORT if provided by the platform; fallback to 8080 for local dev
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

// handlerSearch 处理搜索请求
func handlerSearch(w http.ResponseWriter, r *http.Request) {
	fmt.Println("Received one request for search")

	lat, _ := strconv.ParseFloat(r.URL.Query().Get("lat"), 64) // 解析纬度参数
	lon, _ := strconv.ParseFloat(r.URL.Query().Get("lon"), 64) // 解析经度参数

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

	// 构建地理距离查询（指定字段、距离、纬度和经度）
	q := elastic.NewGeoDistanceQuery("location").
		Distance(ran).
		Lat(lat).
		Lon(lon)

	// 执行搜索请求（在指定索引中执行查询）
	res, err := client.Search().
		Index(INDEX).
		Query(q).
		Pretty(true).
		Do(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	fmt.Printf("Query took %d ms, total hits %d\n", res.TookInMillis, res.TotalHits())

	var typ Post
	var out []Post
	// 遍历搜索结果，转换为Post结构体
	for _, item := range res.Each(reflect.TypeOf(typ)) {
		p := item.(Post)
		out = append(out, p)
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
			User:    "1111", // 演示用固定用户；后续可替换为真实登录用户
			Message: r.FormValue("message"),
			Location: Location{
				Lat: lat,
				Lon: lon,
			},
		}

		// 从表单获取文件字段：key = "image"
		file, hdr, err := r.FormFile("image")
		if err != nil {
			http.Error(w, "image is not available", http.StatusBadRequest)
			return
		}
		defer file.Close()

		// 上传到 GCS，返回可访问的公开 URL（课堂最简单做法）
		url, err := saveToGCS(r.Context(), BUCKET_NAME, file, hdr.Filename)
		if err != nil {
			log.Printf("GCS upload error: %v", err) // minimal: log the real error for logs
			http.Error(w, "upload to GCS failed", http.StatusInternalServerError)
			return
		}
		p.Url = url
	} else {
		// --- 处理原有 JSON 请求 ---
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&p); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
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
