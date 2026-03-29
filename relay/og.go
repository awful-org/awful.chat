package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// OgPreview represents the Open Graph preview response
type OgPreview struct {
	URL              string  `json:"url"`
	Title            *string `json:"title,omitempty"`
	Description      *string `json:"description,omitempty"`
	SiteName         *string `json:"siteName,omitempty"`
	Image            *string `json:"image,omitempty"`
	ImageWidth       *int    `json:"imageWidth,omitempty"`
	ImageHeight      *int    `json:"imageHeight,omitempty"`
	Video            *string `json:"video,omitempty"`
	VideoWidth       *int    `json:"videoWidth,omitempty"`
	VideoHeight      *int    `json:"videoHeight,omitempty"`
	VideoContentType *string `json:"videoContentType,omitempty"`
	MediaType        string  `json:"mediaType"`
}

var ogRewriteRules = []struct {
	Hosts    []string
	Rewrites []func(*url.URL) string
}{
	{
		Hosts: []string{"instagram.com", "www.instagram.com"},
		Rewrites: []func(*url.URL) string{
			func(u *url.URL) string {
				return fmt.Sprintf("https://d.vxinstagram.com%s%s", u.Path, u.RawQuery)
			},
			func(u *url.URL) string {
				return fmt.Sprintf("https://www.ddinstagram.com%s%s", u.Path, u.RawQuery)
			},
		},
	},
}

func getCandidateUrls(targetURL *url.URL) []string {
	for _, rule := range ogRewriteRules {
		for _, host := range rule.Hosts {
			if targetURL.Host == host {
				results := make([]string, len(rule.Rewrites))
				for i, rewrite := range rule.Rewrites {
					results[i] = rewrite(targetURL)
				}
				return results
			}
		}
	}
	return []string{targetURL.String()}
}

func escapeRegex(s string) string {
	specialChars := []string{".", "*", "+", "?", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"}
	result := s
	for _, char := range specialChars {
		result = strings.ReplaceAll(result, char, "\\"+char)
	}
	return result
}

func extractMetaContent(html string, keys []string) *string {
	for _, key := range keys {
		escaped := escapeRegex(key)
		patterns := []*regexp.Regexp{
			regexp.MustCompile(`<meta[^>]+(?:property|name)=["']` + escaped + `["'][^>]*content=["']([^"']+)["'][^>]*>`),
			regexp.MustCompile(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']` + escaped + `["'][^>]*>`),
		}
		for _, pattern := range patterns {
			matches := pattern.FindStringSubmatch(html)
			if len(matches) > 1 {
				value := strings.TrimSpace(strings.ReplaceAll(matches[1], "&amp;", "&"))
				return &value
			}
		}
	}
	return nil
}

func extractMetaNumber(html string, keys []string) *int {
	val := extractMetaContent(html, keys)
	if val == nil {
		return nil
	}
	n, err := strconv.Atoi(*val)
	if err != nil {
		return nil
	}
	return &n
}

func absolutizeUrl(raw, base string) *string {
	if raw == "" {
		return nil
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil
	}
	result, err := baseURL.Parse(raw)
	if err != nil {
		return nil
	}
	s := result.String()
	return &s
}

func handleOgPreview(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}

	target := r.URL.Query().Get("url")
	target = strings.TrimSpace(target)
	if target == "" {
		apiError(w, r, "Missing url parameter", http.StatusBadRequest)
		return
	}

	targetURL, err := url.Parse(target)
	if err != nil {
		apiError(w, r, "Invalid URL", http.StatusBadRequest)
		return
	}
	if targetURL.Scheme != "http" && targetURL.Scheme != "https" {
		apiError(w, r, "Only http/https URLs are supported", http.StatusBadRequest)
		return
	}

	candidates := getCandidateUrls(targetURL)
	var html string
	finalUrl := targetURL.String()

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return nil
		},
	}

	for _, candidate := range candidates {
		req, err := http.NewRequest("GET", candidate, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "TelegramBot (like TwitterBot)")
		req.Header.Set("Accept", "text/html,application/xhtml+xml")

		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			continue
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			continue
		}
		html = string(body)
		finalUrl = resp.Request.URL.String()
		if finalUrl == "" {
			finalUrl = candidate
		}
		break
	}

	if html == "" {
		apiError(w, r, "All OG sources failed", http.StatusBadGateway)
		return
	}

	preview := OgPreview{
		URL: finalUrl,
	}

	// Extract title
	title := extractMetaContent(html, []string{"og:title", "twitter:title"})
	if title == nil {
		titlePattern := regexp.MustCompile(`<title[^>]*>([^<]+)</title>`)
		matches := titlePattern.FindStringSubmatch(html)
		if len(matches) > 1 {
			s := strings.TrimSpace(matches[1])
			title = &s
		}
	}
	preview.Title = title

	// Extract description
	preview.Description = extractMetaContent(html, []string{"og:description", "twitter:description", "description"})

	// Extract site name
	preview.SiteName = extractMetaContent(html, []string{"og:site_name"})

	// Extract video
	if videoURL := extractMetaContent(html, []string{"og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"}); videoURL != nil {
		preview.Video = absolutizeUrl(*videoURL, finalUrl)
	}
	preview.VideoWidth = extractMetaNumber(html, []string{"og:video:width", "twitter:player:width"})
	preview.VideoHeight = extractMetaNumber(html, []string{"og:video:height", "twitter:player:height"})
	preview.VideoContentType = extractMetaContent(html, []string{"og:video:type", "twitter:player:stream:content_type"})

	// Extract image
	if imageURL := extractMetaContent(html, []string{"og:image", "twitter:image", "twitter:image:src"}); imageURL != nil {
		preview.Image = absolutizeUrl(*imageURL, finalUrl)
	}
	preview.ImageWidth = extractMetaNumber(html, []string{"og:image:width", "twitter:image:width"})
	preview.ImageHeight = extractMetaNumber(html, []string{"og:image:height", "twitter:image:height"})

	// If no image but has video, try poster attribute
	if preview.Image == nil && preview.Video != nil {
		posterPattern := regexp.MustCompile(`poster=["']([^"']+)["']`)
		matches := posterPattern.FindStringSubmatch(html)
		if len(matches) > 1 {
			preview.Image = absolutizeUrl(matches[1], finalUrl)
		}
	}

	// Determine media type
	if preview.Video != nil {
		preview.MediaType = "video"
	} else if preview.Image != nil {
		preview.MediaType = "image"
	} else {
		preview.MediaType = "none"
	}

	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(preview)
	})
}
