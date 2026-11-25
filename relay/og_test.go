package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
)

// An Instagram post is asked of Instagram first and of the mirror second, and
// nothing else Instagram has is asked of the mirror at all.
func TestInstagramCandidateURLs(t *testing.T) {
	const post = "https://www.instagram.com/p/abc-12_3/"
	cases := map[string][]string{
		post: {post, "https://kkinstagram.com/p/abc-12_3/"},
		// Which picture is passed on; who shared the link is not.
		post + "?img_index=2&igsh=c2VjcmV0": {post + "?img_index=2&igsh=c2VjcmV0", "https://kkinstagram.com/p/abc-12_3/?img_index=2"},
		post + "?igsh=c2VjcmV0":             {post + "?igsh=c2VjcmV0", "https://kkinstagram.com/p/abc-12_3/"},
		"https://instagram.com/reel/abc":    {"https://instagram.com/reel/abc", "https://kkinstagram.com/reel/abc"},
		"https://www.instagram.com/some.one/reel/abc/": {
			"https://www.instagram.com/some.one/reel/abc/", "https://kkinstagram.com/some.one/reel/abc/"},
		"https://www.instagram.com/some.one/":      {"https://www.instagram.com/some.one/"},
		"https://www.instagram.com/direct/inbox/":  {"https://www.instagram.com/direct/inbox/"},
		"https://www.instagram.com/p/a/../../x/":   {"https://www.instagram.com/p/a/../../x/"},
		"https://example.com/p/abc/":               {"https://example.com/p/abc/"},
		"https://www.instagram.com.example/p/abc/": {"https://www.instagram.com.example/p/abc/"},
	}
	for link, want := range cases {
		if got := getCandidateUrls(mustURL(t, link)); !slices.Equal(got, want) {
			t.Errorf("%s: %v, want %v", link, got, want)
		}
	}
}

func parsePage(page string) OgPreview {
	return ogParse(ogPage{url: "https://example.com/post", html: page})
}

func value(s *string) string {
	if s == nil {
		return "<none>"
	}
	return *s
}

// Matching the raw text cut a value at its first apostrophe and left every
// entity but &amp; undecoded.
func TestOgParseReadsTheWholeValue(t *testing.T) {
	cases := map[string]string{
		`<meta property="og:title" content="It's a cat">`:                                    "It's a cat",
		`<meta property='og:title' content='She said "hi"'>`:                                 `She said "hi"`,
		`<meta content="It's a cat" property="og:title">`:                                    "It's a cat",
		`<meta property="og:title" content="Schr&#246;dinger&#039;s &quot;cat&quot; &amp;">`: `Schrödinger's "cat" &`,
		`<META PROPERTY="OG:Title" CONTENT="capitals">`:                                      "capitals",
		`<meta property=og:title content=bare>`:                                              "bare",
		`<meta data-x="1" name="og:title" content="by name" />`:                              "by name",
		"<meta\n property=\"og:title\"\n content=\"two\nlines\">":                            "two\nlines",
		`<meta property="og:title" content="a > b">`:                                         "a > b",
		// An empty tag says nothing, and the first that says something wins.
		`<meta property="og:title" content=""><meta property="og:title" content="one"><meta property="og:title" content="two">`: "one",
		`<meta name="twitter:title" content="t"><meta property="og:title" content="og">`:                                        "og",
		`<title> A &amp; B </title><svg><title>icon</title></svg>`:                                                              "A & B",
		`<title></title>`: "<none>",
		// What only looks like a tag is not one.
		`<!-- <meta property="og:title" content="commented"> --><title>real</title>`:             "real",
		`<script>var x = '<meta property="og:title" content="script">'</script><title>r</title>`: "r",
		`<meta property="og:title" content="cut off`:                                             "<none>",
	}
	for page, want := range cases {
		if got := value(parsePage(page).Title); got != want {
			t.Errorf("%s: title %q, want %q", page, got, want)
		}
	}
}

func TestOgParseMedia(t *testing.T) {
	p := parsePage(`<meta property="og:video:url" content="/v.mp4?a=1&amp;b=2">` +
		`<meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="640">` +
		`<video poster="/poster.jpg"></video><meta name="description" content="what it's about">`)
	if p.MediaType != "video" || value(p.Video) != "https://example.com/v.mp4?a=1&b=2" ||
		value(p.Image) != "https://example.com/poster.jpg" || value(p.VideoContentType) != "video/mp4" ||
		p.VideoWidth == nil || *p.VideoWidth != 640 || value(p.Description) != "what it's about" {
		t.Errorf("video page: %+v", p)
	}
	// Decoding entities must not let a page smuggle a scheme past the check.
	p = parsePage(`<meta property="og:image" content="java&#115;cript:alert(1)">`)
	if p.Image != nil || p.MediaType != "none" {
		t.Errorf("a javascript: picture came through: %v", value(p.Image))
	}
	// A link that is itself a picture or a video.
	p = ogParse(ogPage{url: "https://cdn.example.com/a.jpg", media: "image/jpeg"})
	if p.MediaType != "image" || value(p.Image) != "https://cdn.example.com/a.jpg" || p.Video != nil {
		t.Errorf("picture: %+v", p)
	}
	p = ogParse(ogPage{url: "https://cdn.example.com/a", media: "video/mp4"})
	if p.MediaType != "video" || value(p.Video) != "https://cdn.example.com/a" || value(p.VideoContentType) != "video/mp4" || p.Image != nil {
		t.Errorf("video: %+v", p)
	}
}

// The next candidate is asked when one fails, or answers with nothing to
// show; what did answer is kept if none does better.
func TestOgBuildFallsBackToTheNextCandidate(t *testing.T) {
	const own, mirror = "https://www.instagram.com/p/abc/", "https://kkinstagram.com/p/abc/"
	picture := ogPage{url: "https://cdn.example.com/a.jpg", media: "image/jpeg"}
	wall := ogPage{url: own, html: "<title>Instagram</title>"}
	full := ogPage{url: own, html: `<meta property="og:title" content="A post"><meta property="og:image" content="/a.jpg">`}
	cases := []struct {
		name  string
		pages map[string]ogPage
		asked int
		title string
		media string
	}{
		{"refused", map[string]ogPage{mirror: picture}, 2, "<none>", "image"},
		{"login wall", map[string]ogPage{own: wall, mirror: picture}, 2, "<none>", "image"},
		{"wall and no mirror", map[string]ogPage{own: wall}, 2, "Instagram", "none"},
		{"answers itself", map[string]ogPage{own: full, mirror: picture}, 1, "A post", "image"},
		{"neither", nil, 2, "", ""},
	}
	saved := ogFetchPage
	t.Cleanup(func() { ogFetchPage = saved })
	for _, c := range cases {
		asked := 0
		ogFetchPage = func(candidate string) (ogPage, bool) {
			asked++
			p, ok := c.pages[candidate]
			return p, ok
		}
		body := ogBuild(mustURL(t, own))
		if asked != c.asked {
			t.Errorf("%s: asked %d candidates, want %d", c.name, asked, c.asked)
		}
		if c.media == "" {
			if body != nil {
				t.Errorf("%s: got %s", c.name, body)
			}
			continue
		}
		var p OgPreview
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatal(err)
		}
		if value(p.Title) != c.title || p.MediaType != c.media {
			t.Errorf("%s: %s", c.name, body)
		}
	}
}

// A picture is not read as a page, and a page is.
func TestOgFetchPageKnowsMediaFromPages(t *testing.T) {
	saved := ogHTTPClient
	t.Cleanup(func() { ogHTTPClient = saved })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/a.jpg", http.StatusFound)
		case "/a.jpg":
			w.Header().Set("Content-Type", "image/jpeg; q=1")
			w.Write([]byte("not html"))
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte("<title>x</title>"))
		case "/empty":
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ogHTTPClient = srv.Client()
	if p, ok := ogFetchPage(srv.URL + "/moved"); !ok || p.media != "image/jpeg" || p.url != srv.URL+"/a.jpg" || p.html != "" {
		t.Errorf("a redirect to a picture: %v %+v", ok, p)
	}
	if p, ok := ogFetchPage(srv.URL + "/page"); !ok || p.media != "" || p.html != "<title>x</title>" {
		t.Errorf("a page: %v %+v", ok, p)
	}
	for _, path := range []string{"/empty", "/gone"} {
		if p, ok := ogFetchPage(srv.URL + path); ok {
			t.Errorf("%s answered: %+v", path, p)
		}
	}
}

func TestIsDisallowedIP(t *testing.T) {
	// The ranges the stdlib predicates already covered, kept here so a future
	// edit to isDisallowedIP cannot quietly drop one of them.
	blocked := []string{
		"127.0.0.1",       // loopback
		"10.1.2.3",        // private
		"172.16.0.1",      // private
		"192.168.1.1",     // private
		"169.254.169.254", // link-local, the cloud metadata endpoint
		"0.0.0.0",         // unspecified
		"224.0.0.1",       // multicast
		"239.255.255.255", // multicast, top of 224.0.0.0/4
		"::1",             // IPv6 loopback
		"fd00::1",         // IPv6 unique-local
		"fe80::1",         // IPv6 link-local
		// The ranges disallowedNets adds. 100.64/10 is the one that matters:
		// it is where Tailscale and several providers' internal networks live,
		// and coturn's denied-peer-ip list already covers it.
		"100.64.0.1",
		"100.127.255.255",
		"0.0.0.1",
		"198.18.0.1",
		"198.19.255.255",
		"240.0.0.1",
		"255.255.255.255",
		// An IPv4-mapped IPv6 literal must not be a way around any of it.
		"::ffff:100.64.0.1",
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if !isDisallowedIP(ip) {
			t.Errorf("%s should be disallowed", s)
		}
	}

	// Public addresses must still resolve, including the ones adjacent to the
	// new ranges - an off-by-one in a CIDR would break real previews.
	allowed := []string{
		"1.1.1.1",
		"8.8.8.8",
		"100.63.255.255", // just below CGNAT
		"100.128.0.0",    // just above CGNAT
		"198.17.255.255", // just below the benchmarking range
		"198.20.0.0",     // just above the benchmarking range
		"2606:4700:4700::1111",
	}
	for _, s := range allowed {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if isDisallowedIP(ip) {
			t.Errorf("%s should be allowed", s)
		}
	}

	if !isDisallowedIP(nil) {
		t.Error("a nil IP must be disallowed")
	}
}

// An IPv6 transition address is only as public as the IPv4 address inside
// it: through the host's NAT64, 64:ff9b::a9fe:a9fe is the metadata service.
func TestIsDisallowedIPLooksInsideTransitionAddresses(t *testing.T) {
	blocked := []string{
		"64:ff9b::a9fe:a9fe",  // NAT64 of 169.254.169.254
		"64:ff9b::7f00:1",     // NAT64 of 127.0.0.1
		"64:ff9b::a00:1",      // NAT64 of 10.0.0.1
		"2002:a9fe:a9fe::1",   // 6to4 of 169.254.169.254
		"2002:c0a8:101::",     // 6to4 of 192.168.1.1
		"::7f00:1",            // IPv4-compatible 127.0.0.1
		"::a00:1",             // IPv4-compatible 10.0.0.1
		"64:ff9b:1::a00:1",    // local-use NAT64: refused outright
		"64:ff9b:1:ffff::808", // however the IPv4 is laid out in it
		"2001:0:4136:e378::1", // Teredo: refused outright
	}
	for _, s := range blocked {
		if !isDisallowedIP(net.ParseIP(s)) {
			t.Errorf("%s should be disallowed", s)
		}
	}
	allowed := []string{
		"64:ff9b::808:808", // NAT64 of 8.8.8.8
		"2002:808:808::1",  // 6to4 of 8.8.8.8
		"2001:db8::1",      // not Teredo: 2001:db8::/32 is next door
		"2001:4860::8888",  // Google, a real 2001:: address outside 2001::/32
	}
	for _, s := range allowed {
		if isDisallowedIP(net.ParseIP(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
}

// Only the web's ports, on every outbound fetch path.
func TestSafeDialsRefuseOtherPorts(t *testing.T) {
	for _, dial := range []func(context.Context, string, string) (net.Conn, error){ogSafeDial, pluginProxySafeDial} {
		for _, addr := range []string{"example.com:22", "example.com:6379", "example.com:8080"} {
			if c, err := dial(context.Background(), "tcp", addr); err == nil {
				c.Close()
				t.Errorf("dialled %s", addr)
			} else if !strings.Contains(err.Error(), "disallowed port") {
				t.Errorf("%s: refused for the wrong reason: %v", addr, err)
			}
		}
	}
	req := httptest.NewRequest("GET", "/og/preview?url="+url.QueryEscape("http://example.com:6379/"), nil)
	rec := httptest.NewRecorder()
	handleOgPreview(rec, req)
	if rec.Code != 400 {
		t.Errorf("a preview of port 6379 got %d, want 400", rec.Code)
	}
}

// A preview hands its urls to an img src and a video element in every client
// that shows it, so only absolute http(s) urls may come back.
func TestAbsolutizeUrlOnlyReturnsWebURLs(t *testing.T) {
	base := "https://example.com/post/1"
	cases := map[string]string{
		"/img.png":                      "https://example.com/img.png",
		"https://cdn.example.com/a.jpg": "https://cdn.example.com/a.jpg",
		"//cdn.example.com/a.jpg":       "https://cdn.example.com/a.jpg",
		"javascript:alert(1)":           "",
		"JavaScript:alert(1)":           "",
		"data:image/svg+xml,<svg/>":     "",
		"file:///etc/passwd":            "",
		"blob:https://example.com/uuid": "",
		"ftp://example.com/a.png":       "",
		"https://user:pw@example.com/a": "",
	}
	for raw, want := range cases {
		got := absolutizeUrl(raw, base)
		switch {
		case want == "" && got != nil:
			t.Errorf("%q: returned %q, want nothing", raw, *got)
		case want != "" && (got == nil || *got != want):
			t.Errorf("%q: got %v, want %q", raw, got, want)
		}
	}
}
