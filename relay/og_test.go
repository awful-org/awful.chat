package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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
		"https://www.instagram.com/some.one/": {"https://www.instagram.com/some.one/"},
		// A share's id is one person's.
		"https://www.instagram.com/share/reel/abc/": {"https://www.instagram.com/share/reel/abc/"},
		"https://www.instagram.com/Share/p/abc":     {"https://www.instagram.com/Share/p/abc"},
		post + "?img_index=sharer-1234":             {post + "?img_index=sharer-1234", "https://kkinstagram.com/p/abc-12_3/"},
		"https://www.instagram.com/direct/inbox/":   {"https://www.instagram.com/direct/inbox/"},
		"https://www.instagram.com/p/a/../../x/":    {"https://www.instagram.com/p/a/../../x/"},
		"https://example.com/p/abc/":                {"https://example.com/p/abc/"},
		"https://www.instagram.com.example/p/abc/":  {"https://www.instagram.com.example/p/abc/"},
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
		`<noscript><meta property="og:title" content="no scripts"></noscript>`: "no scripts",
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

// Nothing a page says comes back at any length it likes.
func TestOgParseCapsWhatItKeeps(t *testing.T) {
	long := strings.Repeat("\u00e9<", 1<<17)
	p := parsePage(`<meta property="og:title" content="` + long + `"><meta property="og:description" content="` + long +
		`"><meta property="og:site_name" content="` + long + `"><meta property="og:video:type" content="` + long +
		`"><meta property="og:image" content="/` + long + `"><meta property="og:video" content="https://a.b/` + strings.Repeat("v", ogMaxURL) + `">`)
	for name, c := range map[string]struct {
		got *string
		max int
	}{
		"title": {p.Title, ogMaxTitle}, "description": {p.Description, ogMaxDescription},
		"site": {p.SiteName, ogMaxName}, "type": {p.VideoContentType, ogMaxName},
	} {
		if c.got == nil || len(*c.got) > c.max || len(*c.got) < c.max-4 || !utf8.ValidString(*c.got) {
			t.Errorf("%s: %d bytes, want up to %d", name, len(value(c.got)), c.max)
		}
	}
	if p.Image != nil || p.Video != nil {
		t.Errorf("a cut url came back: %d and %d bytes", len(value(p.Image)), len(value(p.Video)))
	}
	body, err := json.Marshal(p)
	if err != nil || len(body) > ogCacheMaxBodyBytes {
		t.Errorf("the answer is %d bytes", len(body))
	}
	// However the cut falls, a cut url is none: here inside a character, and
	// on a space.
	for _, tail := range []string{strings.Repeat("\u00e9", 40), strings.Repeat(" x", 40)} {
		for pad := 0; pad < 4; pad++ {
			img := "/" + strings.Repeat("a", ogMaxURL-30-pad) + tail
			if p := parsePage(`<meta property="og:image" content="` + img + `">`); p.Image != nil {
				t.Errorf("a cut url came back: %d of %d bytes", len(*p.Image), len(img))
			}
		}
	}
	// Not UTF-8 at all.
	if got := value(parsePage(`<meta property="og:title" content="` + strings.Repeat("\x80", 500) + `">`).Title); len(got) < ogMaxTitle-4 {
		t.Errorf("a title that is not UTF-8: %d bytes", len(got))
	}
	// A title only in <title>, and a long one.
	if got := value(parsePage("<title>" + long + "</title>").Title); len(got) > ogMaxTitle {
		t.Errorf("<title>: %d bytes", len(got))
	}
}

// One tag as long as a page: what came before it is kept, and reading it stops
// short of the tokenizer's copies of each of its attributes.
func TestOgParseStopsAtAnEndlessTag(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<meta property="og:title" content="before"><a`)
	for i := 0; b.Len() < ogMaxPageBytes; i++ {
		b.WriteByte(' ')
		b.WriteString(strconv.FormatInt(int64(i), 36))
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	p := parsePage(b.String())
	runtime.ReadMemStats(&after)
	if value(p.Title) != "before" {
		t.Errorf("title %q", value(p.Title))
	}
	if mb := (after.TotalAlloc - before.TotalAlloc) >> 20; mb > 160 {
		t.Errorf("one page allocated %d MB", mb)
	}
}

// A first candidate that hangs leaves the next one time of its own.
func TestOgBuildSharesItsDeadline(t *testing.T) {
	saved := ogFetchPage
	t.Cleanup(func() { ogFetchPage = saved })
	var shares []time.Duration
	ogFetchPage = func(ctx context.Context, candidate string) (ogPage, bool) {
		d, ok := ctx.Deadline()
		if !ok {
			t.Error("no deadline")
		}
		shares = append(shares, time.Until(d))
		return ogPage{}, false
	}
	ogBuild("203.0.113.9", mustURL(t, "https://www.instagram.com/p/abc/"))
	if len(shares) != 2 || shares[0] > ogDeadline/2 || shares[1] > ogDeadline {
		t.Errorf("shares %v of %v", shares, ogDeadline)
	}
	if ogMaxWait+ogDeadline >= 15*time.Second {
		t.Error("longer than the API server's WriteTimeout")
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
		ogFetchPage = func(_ context.Context, candidate string) (ogPage, bool) {
			asked++
			p, ok := c.pages[candidate]
			return p, ok
		}
		body, busy := ogBuild("203.0.113.9", mustURL(t, own))
		if busy {
			t.Errorf("%s: busy", c.name)
		}
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
		case "/b.mp4":
			w.Header().Set("Content-Type", "video/mp4; codecs=avc1.42E01E, mp4a.40.2")
			w.Write([]byte("not html"))
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte("<title>x</title>"))
		case "/far":
			http.Redirect(w, r, "/page?"+strings.Repeat("&", ogMaxURL), http.StatusFound)
		case "/empty":
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ogHTTPClient = srv.Client()
	if p, ok := ogFetchPage(context.Background(), srv.URL+"/moved"); !ok || p.media != "image/jpeg" || p.url != srv.URL+"/a.jpg" || p.html != "" {
		t.Errorf("a redirect to a picture: %v %+v", ok, p)
	}
	if p, ok := ogFetchPage(context.Background(), srv.URL+"/b.mp4"); !ok || p.media != "video/mp4" {
		t.Errorf("a video with a sloppy type: %v %+v", ok, p)
	}
	if p, ok := ogFetchPage(context.Background(), srv.URL+"/page"); !ok || p.media != "" || p.html != "<title>x</title>" {
		t.Errorf("a page: %v %+v", ok, p)
	}
	for _, path := range []string{"/empty", "/gone", "/far"} {
		if p, ok := ogFetchPage(context.Background(), srv.URL+path); ok {
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

// Go reads 10 MiB of a server's headers, thirty servers at a time, unless told
// not to.
func TestOgClientBoundsResponseHeaders(t *testing.T) {
	transport := ogHTTPClient.Transport.(*http.Transport).Clone()
	transport.DialContext = nil // the test server is on loopback
	client := &http.Client{Transport: transport}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 200; i++ {
			w.Header().Add("X-Pad", strings.Repeat("p", 1000))
		}
	}))
	defer srv.Close()
	if resp, err := client.Get(srv.URL); err == nil {
		resp.Body.Close()
		t.Fatal("200 kB of headers were read")
	}
}

// An answer already had is kept when the next candidate's page cannot be
// parsed in time.
func TestOgBuildKeepsWhatItHasWhenBusy(t *testing.T) {
	savedFetch, savedSlots := ogFetchPage, ogParseSlots
	t.Cleanup(func() { ogFetchPage, ogParseSlots = savedFetch, savedSlots })
	ogParseSlots = make(chan struct{}, 1)
	asked := 0
	ogFetchPage = func(ctx context.Context, candidate string) (ogPage, bool) {
		if asked++; asked == 2 {
			ogParseSlots <- struct{}{} // taken, and never given back
		}
		return ogPage{url: candidate, html: "<title>wall</title>"}, true
	}
	body, busy := ogBuild("203.0.113.9", mustURL(t, "https://www.instagram.com/p/abc/"))
	if busy || !strings.Contains(string(body), "wall") {
		t.Errorf("busy %v, body %s", busy, body)
	}
}
