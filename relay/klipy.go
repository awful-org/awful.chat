package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
)

var (
	klipyAPIBase = "https://api.klipy.com/api/v1"
	klipyAPIKey  = os.Getenv("KLIPY_API_KEY")
)

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
	if klipyAPIKey == "" {
		apiError(w, r, "KLIPY_API_KEY not configured", http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query().Get("q")
	limit := r.URL.Query().Get("limit")
	if limit == "" {
		limit = "18"
	}
	page := r.URL.Query().Get("page")
	if page == "" {
		page = "1"
	}

	apiURL := fmt.Sprintf("%s/%s/gifs/search?q=%s&limit=%s&page=%s",
		klipyAPIBase,
		klipyAPIKey,
		url.QueryEscape(q),
		limit,
		page,
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		apiError(w, r, fmt.Sprintf("Failed to fetch from Klipy: %v", err), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		apiError(w, r, fmt.Sprintf("Klipy API error: %d - %s", resp.StatusCode, string(body)), resp.StatusCode)
		return
	}

	var result KlipyAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		apiError(w, r, fmt.Sprintf("Failed to decode Klipy response: %v", err), http.StatusInternalServerError)
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
	if klipyAPIKey == "" {
		apiError(w, r, "KLIPY_API_KEY not configured", http.StatusServiceUnavailable)
		return
	}

	limit := r.URL.Query().Get("limit")
	if limit == "" {
		limit = "18"
	}
	page := r.URL.Query().Get("page")
	if page == "" {
		page = "1"
	}

	apiURL := fmt.Sprintf("%s/%s/gifs/trending?limit=%s&page=%s",
		klipyAPIBase,
		klipyAPIKey,
		limit,
		page,
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		apiError(w, r, fmt.Sprintf("Failed to fetch from Klipy: %v", err), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		apiError(w, r, fmt.Sprintf("Klipy API error: %d - %s", resp.StatusCode, string(body)), resp.StatusCode)
		return
	}

	var result KlipyAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		apiError(w, r, fmt.Sprintf("Failed to decode Klipy response: %v", err), http.StatusInternalServerError)
		return
	}

	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})
}
