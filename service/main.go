package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"strconv"

	// 导入Elasticsearch官方Go客户端
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
	User     string   `json:"user"`     // 用户名
	Message  string   `json:"message"`  // 帖子内容
	Location Location `json:"location"` // 帖子对应的地理位置
}

const (
	// ES_URL 是Elasticsearch服务器的地址
	ES_URL = "http://34.44.14.36:9200"
	// INDEX 是ES中存储帖子数据的索引名称
	INDEX = "posts"
	// DISTANCE 是默认的搜索距离范围，单位为公里
	DISTANCE = "200km"
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
	http.HandleFunc("/post", handlerPost)        // 注册发帖处理函数
	http.HandleFunc("/search", handlerSearch)    // 注册搜索处理函数
	log.Fatal(http.ListenAndServe(":8080", nil)) // 启动HTTP服务器
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

	// 解析请求体（把JSON解到Post结构体）
	decoder := json.NewDecoder(r.Body)
	var p Post
	if err := decoder.Decode(&p); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
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
