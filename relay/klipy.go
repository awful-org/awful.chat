package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	klipyAPIBase = "https://api.klipy.com/api/v1"
	klipyAPIKey  = os.Getenv("KLIPY_API_KEY")
)

const (
	// /klipy/search and /klipy/trending are publicly routed and
	// unauthenticated (isAllowedOrigin returns true for a request with no
	// Origin header at all), so without a budget anyone with curl can spend
	// the operator's paid KLIPY_API_KEY quota. The GIF picker is chatty - a
	// debounced typeahead plus infinite scroll, and search and trending share
	// this one bucket because they share one paid quota - so the budget is
	// looser than pluginProxyRateLimit's 10/min. Shared-NAT offices sit behind
	// one apparent IP, which is the other reason not to set it tight.
	klipyRateLimit = 60
	// An upstream error page is logged for diagnosis; cap the read so a
	// misbehaving or hostile upstream cannot stream unbounded bytes into
	// memory and the log.
	klipyMaxErrorBody = 4 << 10
)

// One client with an explicit timeout for every Klipy call. http.Get uses
// http.DefaultClient, which has NO timeout at all: a hung upstream would pin
// the handler goroutine and its socket forever.
var klipyHTTPClient = &http.Client{Timeout: 10 * time.Second}

// klipyRedact strips the app key out of anything headed for the log. The key
// is a PATH segment of every upstream URL, and *url.Error prints that URL
// verbatim (net/http redacts only userinfo), so logging a raw transport error
// wrote the operator's paid key straight into the relay's logs.
func klipyRedact(s string) string {
	if klipyAPIKey == "" {
		return s
	}
	return strings.ReplaceAll(s, klipyAPIKey, "<redacted>")
}

// klipyIntParam parses a caller-supplied count as a number so it reaches the
// upstream URL as digits. limit and page were interpolated into the query
// string unescaped, which let a caller append arbitrary upstream parameters.
func klipyIntParam(raw string, def, max int) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// KlipyGifResponse represents a GIF from Klipy API
type KlipyGifResponse struct {
	ID      string `json:"id"`
	URL     string `json:"url"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Size    int    `json:"size"`
	Preview string `json:"preview"`
	Title   string `json:"title"`
}

// KlipySearchResponse represents the search API response (use raw message to handle any structure)
type KlipySearchResponse struct {
	Result bool                   `json:"result"`
	Data   map[string]interface{} `json:"data"`
}

type KlipyMediaFormat struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int    `json:"size"`
}

type KlipyMediaSizes struct {
	Gif  *KlipyMediaFormat `json:"gif,omitempty"`
	Webp *KlipyMediaFormat `json:"webp,omitempty"`
	Jpg  *KlipyMediaFormat `json:"jpg,omitempty"`
	Mp4  *KlipyMediaFormat `json:"mp4,omitempty"`
	Webm *KlipyMediaFormat `json:"webm,omitempty"`
}

type KlipyFile struct {
	Hd *KlipyMediaSizes `json:"hd,omitempty"`
	Md *KlipyMediaSizes `json:"md,omitempty"`
	Sm *KlipyMediaSizes `json:"sm,omitempty"`
	Xs *KlipyMediaSizes `json:"xs,omitempty"`
}

type KlipyGifItem struct {
	ID          int        `json:"id"`
	Slug        string     `json:"slug"`
	Title       string     `json:"title"`
	File        *KlipyFile `json:"file,omitempty"`
	BlurPreview string     `json:"blur_preview,omitempty"`
	Type        string     `json:"type"`
}

type KlipyResponseData struct {
	Data        []KlipyGifItem `json:"data"`
	CurrentPage int            `json:"current_page,omitempty"`
	PerPage     int            `json:"per_page,omitempty"`
	HasNext     bool           `json:"has_next,omitempty"`
}

type KlipyAPIResponse struct {
	Result bool              `json:"result"`
	Data   KlipyResponseData `json:"data"`
}

func handleKlipySearch(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllow("klipy:"+clientIP(r), klipyRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}
	if klipyAPIKey == "" {
		apiError(w, r, "KLIPY_API_KEY not configured", http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query().Get("q")
	limit := klipyIntParam(r.URL.Query().Get("limit"), 18, 50)
	page := klipyIntParam(r.URL.Query().Get("page"), 1, 1000)

	apiURL := fmt.Sprintf("%s/%s/gifs/search?q=%s&limit=%d&page=%d",
		klipyAPIBase,
		klipyAPIKey,
		url.QueryEscape(q),
		limit,
		page,
	)

	resp, err := klipyHTTPClient.Get(apiURL)
	if err != nil {
		log.Printf("[klipy] search fetch error: %s", klipyRedact(err.Error()))
		apiError(w, r, "Failed to fetch from Klipy", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, klipyMaxErrorBody))
		log.Printf("[klipy] search API error: %d - %s", resp.StatusCode, klipyRedact(string(body)))
		apiError(w, r, "Failed to fetch from Klipy", resp.StatusCode)
		return
	}

	var result KlipyAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[klipy] search decode error: %s", klipyRedact(err.Error()))
		apiError(w, r, "Failed to decode Klipy response", http.StatusInternalServerError)
		return
	}

	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})
}

func handleKlipyTrending(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllow("klipy:"+clientIP(r), klipyRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}
	if klipyAPIKey == "" {
		apiError(w, r, "KLIPY_API_KEY not configured", http.StatusServiceUnavailable)
		return
	}

	limit := klipyIntParam(r.URL.Query().Get("limit"), 18, 50)
	page := klipyIntParam(r.URL.Query().Get("page"), 1, 1000)

	apiURL := fmt.Sprintf("%s/%s/gifs/trending?limit=%d&page=%d",
		klipyAPIBase,
		klipyAPIKey,
		limit,
		page,
	)

	resp, err := klipyHTTPClient.Get(apiURL)
	if err != nil {
		log.Printf("[klipy] trending fetch error: %s", klipyRedact(err.Error()))
		apiError(w, r, "Failed to fetch from Klipy", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, klipyMaxErrorBody))
		log.Printf("[klipy] trending API error: %d - %s", resp.StatusCode, klipyRedact(string(body)))
		apiError(w, r, "Failed to fetch from Klipy", resp.StatusCode)
		return
	}

	var result KlipyAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[klipy] trending decode error: %s", klipyRedact(err.Error()))
		apiError(w, r, "Failed to decode Klipy response", http.StatusInternalServerError)
		return
	}

	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})
}
