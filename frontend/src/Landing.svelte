<script lang="ts">
  let currentSection = $state("");

  const navLinks = [
    { href: "#hero", label: "Awful.chat", accent: true },
    { href: "#features", label: "Features" },
    { href: "#stack", label: "Stack" },
    { href: "#deploy", label: "Deploy" },
    { href: "https://github.com", label: "GitHub", external: true },
  ];

  const marqueeItems = [
    { text: "NO ACCOUNTS", highlight: false },
    { text: "E2E ENCRYPTED", highlight: true },
    { text: "P2P MESH", highlight: false },
    { text: "SELF-HOSTED", highlight: true },
    { text: "OPEN SOURCE", highlight: false },
    { text: "WEBRTC", highlight: true },
    { text: "MEDIASOUP", highlight: false },
    { text: "ZERO KNOWLEDGE", highlight: true },
  ];

  const stats = [
    { value: "0", label: "EMAILS REQUIRED" },
    { value: "0", label: "PHONE NUMBERS" },
    { value: "0", label: "DATA COLLECTED" },
  ];

  const serverVisibility = [
    { canSee: true, label: "WebSocket connection" },
    { canSee: true, label: "Your ephemeral assigned ID" },
    { canSee: true, label: "Room code" },
    { canSee: false, label: "Message content" },
    { canSee: false, label: "Files & media" },
    { canSee: false, label: "Voice & video" },
  ];

  const stackItems = [
    {
      category: "ENCRYPTION",
      title: "AES-GCM",
      subtitle: "",
      description:
        "256-bit encryption at rest. Your messages are encrypted before they leave your device.",
      classes: "bento-item-lg",
    },
    {
      category: "IDENTITY",
      title: "BIP39",
      subtitle: "ed25519 keypair",
      description: "Same standard used by Bitcoin. Battle-tested cryptography.",
      classes: "bento-item-tall",
    },
    {
      category: "REALTIME",
      title: "WebRTC",
      subtitle: "",
      description: "Direct P2P connections. No middleman.",
      classes: "",
    },
    {
      category: "MEDIA",
      title: "mediasoup",
      subtitle: "",
      description: "SFU for scalable voice & video calls.",
      classes: "",
    },
    {
      category: "FILES",
      title: "WebTorrent",
      subtitle: "",
      description: "P2P file sharing. Any size.",
      classes: "",
    },
    {
      category: "STORAGE",
      title: "IndexedDB",
      subtitle: "",
      description:
        "Local-first architecture. Works offline. Syncs when you reconnect.",
      classes: "bento-item-lg",
    },
  ];

  const deployFeatures = [
    {
      tag: "100%",
      title: "Open Source",
      description: "MIT licensed. Fork it. Audit it. Modify it.",
    },
    {
      tag: "DOCKER",
      title: "One Command Deploy",
      description: `Works on any server with Docker.
        (firewall rules also needs to be configured)`,
    },
    {
      tag: "FULL",
      title: "Data Sovereignty",
      description: "Your server. Your rules. You in control.",
    },
  ];

  function handleNavClick(e: MouseEvent, href: string) {
    if (href.startsWith("#")) {
      e.preventDefault();
      document.querySelector(href)?.scrollIntoView({ behavior: "smooth" });
    }
  }

  const isActiveLink = $derived(
    (href: string) => href === "#" + currentSection
  );

  $effect(() => {
    const onScroll = () => {
      document.querySelectorAll<HTMLElement>("section[id]").forEach((s) => {
        if (window.scrollY >= s.offsetTop - 300) currentSection = s.id;
      });
    };
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  });
</script>

<svelte:head>
  <title>Awful.chat - Privacy is not optional</title>
  <link rel="canonical" href="https://awful.chat" />
  <meta name="description" content="End-to-end encrypted P2P chat. Self-hosted. Open source. No accounts required." />
  <meta name="theme-color" content="#050505" />
  <meta name="robots" content="index, follow" />

  <!-- Open Graph -->
  <meta property="og:title" content="Awful.chat - Privacy is not optional" />
  <meta property="og:description" content="End-to-end encrypted P2P chat. Self-hosted. Open source. No accounts required." />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://awful.chat" />
  <meta property="og:site_name" content="Awful.chat" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Awful.chat - Privacy is not optional" />
  <meta name="twitter:description" content="End-to-end encrypted P2P chat. Self-hosted. Open source. No accounts required." />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link
    rel="preconnect"
    href="https://fonts.gstatic.com"
    crossorigin="anonymous"
  />
  <link
    href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<div class="app scanlines noise">
  <!-- Floating Nav -->
  <nav class="nav">
    {#each navLinks as link}
      {#if link.external}
        <a href={link.href} target="_blank" rel="noopener">{link.label}</a>
      {:else}
        <a
          href={link.href}
          class:active={isActiveLink(link.href)}
          class:accent-link={link.accent}
          onclick={(e) => handleNavClick(e, link.href)}>{link.label}</a
        >
      {/if}
    {/each}
  </nav>

  <!-- Hero -->
  <section id="hero" class="hero-section">
    <div class="container">
      <div class="section-num">01 — INTRODUCTION</div>
      <h1 class="display-huge glitch">
        <span class="text-accent glow-text">Privacy</span><br />
        is not<br />
        optional.
      </h1>
      <div class="grid-2col hero-grid">
        <p class="hero-desc">
          End-to-end encrypted. Peer-to-peer. Self-hosted.
          <span class="text-fg">The server is just a dumb signaling pipe.</span>
          It literally cannot read your messages.
        </p>
        <div class="hero-buttons">
          <a href="/app" class="btn btn-primary">
            Start Chatting
            <svg
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              ><path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M17 8l4 4m0 0l-4 4m4-4H3"
              /></svg
            >
          </a>
          <a
            href="https://github.com"
            class="btn btn-outline"
            target="_blank"
            rel="noopener"
          >
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"
              ><path
                d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
              /></svg
            >
            Source
          </a>
        </div>
      </div>
    </div>
    <div class="scroll-hint">Scroll</div>
  </section>

  <!-- Marquee -->
  <div class="marquee">
    <div class="marquee-content">
      {#each [...marqueeItems, ...marqueeItems] as item}
        <span class="marquee-item" class:highlight={item.highlight}
          >{item.text}</span
        >
      {/each}
    </div>
  </div>

  <!-- Identity Section -->
  <section id="features" class="section-center">
    <div class="grid-2col container">
      <div>
        <div class="section-num">02 — IDENTITY</div>
        <h2 class="display-large">
          12 words.<br />
          <span class="text-accent">That's you.</span>
        </h2>
        <p class="section-desc">
          No email. No phone number. No personal data. Your identity is derived
          from a BIP39 seed phrase that generates your ed25519 keypair. Memorize
          it. Burn it. Tattoo it. Your call.
        </p>
        <div class="stats-row">
          {#each stats as stat}
            <div>
              <div class="stat-value">{stat.value}</div>
              <div class="stat-label font-mono">{stat.label}</div>
            </div>
          {/each}
        </div>
      </div>
      <div class="terminal glow-box">
        <div class="terminal-header">
          <div class="terminal-dot" style="background: #ff5f57;"></div>
          <div class="terminal-dot" style="background: #febc2e;"></div>
          <div class="terminal-dot" style="background: #28c840;"></div>
          <span class="terminal-title">identity.gen</span>
        </div>
        <div class="terminal-body">
          <div class="terminal-line">
            <span class="terminal-prompt">$</span>
            <span class="terminal-cmd">awful generate-identity</span>
          </div>
          <div class="terminal-line">
            <span class="terminal-output">Generating BIP39 seed phrase...</span>
          </div>
          <div class="terminal-line" style="margin-top: 1rem;">
            <span class="terminal-output">Seed:</span>
          </div>
          <div class="seed-phrase">
            witch collapse practice feed shame<br />
            open despair creek road again<br />
            ice least
          </div>
          <div class="terminal-line" style="margin-top: 1rem;">
            <span class="terminal-output">Public key:</span>
          </div>
          <div class="pubkey">did:key:6MkjSomRYwejbarg...f3kq</div>
          <div class="terminal-line" style="margin-top: 1rem;">
            <span class="text-accent">Ready.</span>
            <span class="terminal-output">Your identity exists only here.</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Architecture Section -->
  <section class="section-center elevated">
    <div class="container">
      <div class="section-num">03 — ARCHITECTURE</div>
      <div class="grid-2col">
        <div>
          <h2 class="display-large">
            Peer to<br />
            <span class="text-accent">peer.</span>
          </h2>
          <p class="section-desc">
            Messages travel directly between devices via WebRTC. The server only
            helps you find each other—it never sees your conversations. Built on
            mediasoup for voice/video at scale.
          </p>
        </div>
        <div class="visibility-list">
          {#each serverVisibility as item}
            <div class="visibility-item" class:cannot-see={!item.canSee}>
              <div>
                <div class="visibility-label font-mono">
                  {item.canSee ? "SERVER CAN SEE" : "SERVER CANNOT SEE"}
                </div>
                <div class="visibility-text" class:strikethrough={!item.canSee}>
                  {item.label}
                </div>
              </div>
              <div
                class="visibility-icon"
                class:check={item.canSee}
                class:cross={!item.canSee}
              >
                {#if item.canSee}
                  <svg
                    width="32"
                    height="32"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    ><path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M5 13l4 4L19 7"
                    /></svg
                  >
                {:else}
                  <svg
                    width="32"
                    height="32"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    ><path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    /></svg
                  >
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </section>

  <!-- Stack Section -->
  <section id="stack" class="section-padded">
    <div class="container">
      <div class="section-num">04 — STACK</div>
      <h2 class="display-large section-title">
        Built for the<br /><span class="text-accent">paranoid.</span>
      </h2>
      <div class="bento">
        {#each stackItems as item}
          <div class="bento-item {item.classes}">
            <div>
              <div class="bento-category font-mono">{item.category}</div>
              <div class="bento-title">{item.title}</div>
              {#if item.subtitle}
                <div class="bento-subtitle text-muted">{item.subtitle}</div>
              {/if}
            </div>
            <p class="bento-desc text-muted">{item.description}</p>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Self-host Section -->
  <section id="deploy" class="section-center">
    <div class="container">
      <div class="section-num">05 — DEPLOY</div>
      <div class="grid-2col">
        <div>
          <h2 class="display-large">
            Self-host<br />
            <span class="text-accent">everything.</span>
          </h2>
          <p class="section-desc">
            One command. Full control. Run your own instance on any server. We
            don't even need to know you exist. That's the point.
          </p>
          <div class="terminal deploy-terminal">
            <div class="terminal-header">
              <div class="terminal-dot" style="background: #ff5f57;"></div>
              <div class="terminal-dot" style="background: #febc2e;"></div>
              <div class="terminal-dot" style="background: #28c840;"></div>
            </div>
            <div class="terminal-body">
              <div class="terminal-line">
                <span class="terminal-prompt">$</span>
                <span class="terminal-cmd"
                  >git clone https://github.com/FlavioZanoni/awful.chat</span
                >
              </div>
              <div class="terminal-line">
                <span class="terminal-prompt">$</span>
                <span class="terminal-cmd">docker compose up -d</span>
              </div>
              <div class="terminal-line" style="margin-top: 1rem;">
                <span class="text-accent">Done.</span>
                <span class="terminal-output">Running at localhost:5173</span>
              </div>
            </div>
          </div>
        </div>
        <div class="feature-cards">
          {#each deployFeatures as feature}
            <div class="feature-card">
              <div class="feature-tag font-mono">{feature.tag}</div>
              <div class="feature-title">{feature.title}</div>
              <p class="feature-desc text-muted">{feature.description}</p>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </section>

  <!-- CTA Section -->
  <section class="cta-section">
    <div>
      <h2 class="display-huge text-accent glow-text glitch">
        Stop<br />being<br />watched.
      </h2>
      <div class="cta-buttons">
        <a href="/app" class="btn btn-primary btn-large flex justify-center">
          Launch Awful.chat
          <svg
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            ><path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M17 8l4 4m0 0l-4 4m4-4H3"
            /></svg
          >
        </a>
      </div>
      <p class="cta-hint text-muted">
        No signup required. Just generate your seed phrase and go.
      </p>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="footer-content container">
      <div class="footer-brand">
        <div class="footer-logo">
          Awful<span class="text-accent">.chat</span>
        </div>
        <div class="footer-tagline text-muted">
          Privacy is <u>not</u> optional.
        </div>
      </div>
      <div class="footer-links">
        <a href="https://github.com" target="_blank" rel="noopener">GitHub</a>
        <a href="#">Documentation</a>
      </div>
      <div class="footer-license font-mono text-muted">
        100% OPEN SOURCE · MIT LICENSE
      </div>
    </div>
  </footer>
</div>

<style>
  /* CSS variables scoped to the root wrapper — no :root or :global needed */
  .app {
    --bg: #050505;
    --bg-elevated: #0a0a0a;
    --fg: #e8e8e8;
    --fg-muted: #666;
    --accent: #00ff88;
    --accent-dim: #00cc6a;
    --border: #1a1a1a;
    --glow: rgba(0, 255, 136, 0.15);

    min-height: 100vh;
    font-family: "Space Grotesk", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.5;
    overflow-x: hidden;
    /* Reset box model for everything inside */
    box-sizing: border-box;
  }

  .app *,
  .app *::before,
  .app *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  .app ::selection {
    background: var(--accent);
    color: var(--bg);
  }

  /* Typography */
  .font-mono {
    font-family: monospace;
  }

  .display-huge {
    font-size: clamp(5rem, 15vw, 12rem);
    font-weight: 700;
    line-height: 0.9;
    letter-spacing: -0.04em;
  }

  .display-large {
    font-size: clamp(2.5rem, 8vw, 6rem);
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.03em;
  }

  .text-accent {
    color: var(--accent);
  }
  .text-muted {
    color: var(--fg-muted);
  }
  .text-fg {
    color: var(--fg);
  }

  @keyframes glitch {
    0%,
    100% {
      transform: translate(0);
    }
    25% {
      transform: translate(-1px, 1px);
    }
    50% {
      transform: translate(1px, -1px);
    }
    75% {
      transform: translate(-1px, -1px);
    }
  }

  .glitch:hover {
    animation: glitch 0.5s ease infinite;
  }

  /* Scanlines — fixed overlays scoped via the wrapper */
  .scanlines::before {
    content: "";
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.1) 0px,
      rgba(0, 0, 0, 0.1) 1px,
      transparent 1px,
      transparent 2px
    );
    pointer-events: none;
    z-index: 9999;
    opacity: 0.3;
  }

  .noise::after {
    content: "";
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    opacity: 0.03;
    pointer-events: none;
    z-index: 9998;
  }

  .glow-text {
    text-shadow:
      0 0 60px var(--glow),
      0 0 120px var(--glow);
  }
  .glow-box {
    box-shadow:
      0 0 80px var(--glow),
      inset 0 0 40px rgba(0, 255, 136, 0.03);
  }

  /* Layout */
  .container {
    max-width: 1400px;
    margin: 0 auto;
    width: 100%;
  }

  section {
    min-height: 100vh;
    position: relative;
    scroll-snap-align: start;
  }

  section:last-of-type {
    scroll-snap-align: none;
  }

  .section-num {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
    color: var(--fg-muted);
    letter-spacing: 0.2em;
    margin-bottom: 2rem;
  }

  .section-desc {
    font-size: 1.125rem;
    color: var(--fg-muted);
    margin-top: 2rem;
    line-height: 1.8;
    max-width: 500px;
  }

  .section-title {
    margin-bottom: 4rem;
  }
  .section-center {
    display: flex;
    align-items: center;
    padding: 0 2rem 3rem;
  }
  .section-padded {
    padding: 8rem 2rem;
  }
  .elevated {
    background: var(--bg-elevated);
  }

  /* Nav */
  .nav {
    position: fixed;
    top: 2rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 2rem;
    padding: 1rem;
    background: rgba(5, 5, 5, 0.8);
    backdrop-filter: blur(20px);
    border: 1px solid var(--border);
    border-radius: 100px;
  }

  nav a {
    color: var(--fg-muted);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  }

  nav a:hover {
    color: var(--fg);
  }
  nav a.active {
    color: var(--accent);
  }
  nav a.accent-link {
    color: var(--accent);
    font-weight: 600;
  }

  /* Hero */
  .hero-section {
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 6rem 2rem 0 2rem;
  }

  .hero-grid {
    margin-top: 4rem;
    align-items: end;
  }

  .hero-desc {
    font-size: 1.25rem;
    color: var(--fg-muted);
    max-width: 500px;
    line-height: 1.7;
  }

  .hero-buttons {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    justify-content: flex-end;
    padding-right: 250px;
  }

  .grid-2col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4rem;
  }

  .scroll-hint {
    position: absolute;
    bottom: 3rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    color: var(--fg-muted);
    font-size: 0.75rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .scroll-hint::after {
    content: "";
    width: 1px;
    height: 60px;
    background: linear-gradient(to bottom, var(--accent), transparent);
    animation: scroll-pulse 2s ease-in-out infinite;
  }

  @keyframes scroll-pulse {
    0%,
    100% {
      opacity: 0.3;
      transform: scaleY(1);
    }
    50% {
      opacity: 1;
      transform: scaleY(1.2);
    }
  }

  /* Marquee */
  .marquee {
    display: flex;
    overflow: hidden;
    white-space: nowrap;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 2rem 0;
  }

  .marquee-content {
    display: flex;
    animation: marquee 30s linear infinite;
  }

  @keyframes marquee {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(-50%);
    }
  }

  .marquee-item {
    padding: 0 3rem;
    font-size: clamp(1.5rem, 4vw, 3rem);
    font-weight: 600;
    color: var(--fg-muted);
    opacity: 0.3;
  }

  .marquee-item.highlight {
    color: var(--accent);
    opacity: 1;
  }

  /* Stats */
  .stats-row {
    display: flex;
    gap: 3rem;
    margin-top: 3rem;
  }
  .stat-value {
    font-size: 3rem;
    font-weight: 700;
    color: var(--accent);
  }
  .stat-label {
    font-size: 0.75rem;
    color: var(--fg-muted);
  }

  /* Terminal */
  .terminal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.875rem;
  }

  .terminal-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.02);
  }

  .terminal-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  .terminal-title {
    margin-left: auto;
    color: var(--fg-muted);
    font-size: 0.75rem;
  }
  .terminal-body {
    padding: 20px;
  }
  .terminal-line {
    display: flex;
    gap: 12px;
    margin-bottom: 8px;
  }
  .terminal-prompt {
    color: var(--accent);
  }
  .terminal-cmd {
    color: var(--fg);
  }
  .terminal-output {
    color: var(--fg-muted);
  }

  .seed-phrase {
    color: var(--accent);
    padding: 1rem;
    background: rgba(0, 255, 136, 0.05);
    border: 1px solid var(--border);
    margin: 0.5rem 0;
  }

  .pubkey {
    color: var(--fg);
    word-break: break-all;
  }
  .deploy-terminal {
    margin-top: 3rem;
  }

  /* Visibility list */
  .visibility-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
  }

  .visibility-item {
    background: var(--bg);
    padding: 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .visibility-item.cannot-see {
    opacity: 0.4;
  }
  .visibility-label {
    font-size: 0.75rem;
    color: var(--fg-muted);
    margin-bottom: 0.5rem;
  }
  .visibility-text {
    font-size: 1.25rem;
  }
  .visibility-text.strikethrough {
    text-decoration: line-through;
  }
  .visibility-icon {
    font-size: 2rem;
  }
  .visibility-icon.check {
    color: var(--accent);
  }
  .visibility-icon.cross {
    color: #ff4444;
  }

  /* Bento */
  .bento {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--border);
  }

  .bento-item {
    background: var(--bg-elevated);
    padding: 2rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 200px;
    position: relative;
    overflow: hidden;
    transition: background 0.3s;
  }

  .bento-item-lg {
    grid-column: span 2;
  }
  .bento-item-tall {
    grid-row: span 2;
  }
  .bento-category {
    font-size: 0.875rem;
    color: var(--accent);
    margin-bottom: 1rem;
  }
  .bento-title {
    font-size: 2rem;
    font-weight: 600;
  }
  .bento-subtitle {
    margin-top: 0.5rem;
  }
  .bento-desc {
    font-size: 0.875rem;
  }

  /* Feature cards */
  .feature-cards {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .feature-card {
    position: relative;
    padding: 3rem;
    border: 1px solid var(--border);
    background: var(--bg);
    transition: all 0.3s;
  }

  .feature-card:hover {
    border-color: var(--accent);
    transform: translateY(-4px);
  }

  .feature-card::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    width: 4px;
    height: 100%;
    background: var(--accent);
    transform: scaleY(0);
    transition: transform 0.3s;
  }

  .feature-card:hover::before {
    transform: scaleY(1);
  }
  .feature-tag {
    font-size: 0.75rem;
    color: var(--accent);
    margin-bottom: 1rem;
  }
  .feature-title {
    font-size: 1.5rem;
    font-weight: 600;
  }
  .feature-desc {
    margin-top: 0.75rem;
    font-size: 0.875rem;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 2rem;
    font-family: inherit;
    font-size: 1rem;
    font-weight: 600;
    text-decoration: none;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--bg);
  }
  .btn-primary:hover {
    background: var(--accent-dim);
    transform: translateY(-2px);
    box-shadow: 0 10px 40px var(--glow);
  }
  .btn-outline {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
  }
  .btn-outline:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn-large {
    font-size: 2rem;
    padding: 1.25rem 3rem;
  }

  /* CTA */
  .cta-section {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 2rem;
    text-align: center;
  }
  .cta-buttons {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-top: 3rem;
  }
  .cta-hint {
    margin-top: 2rem;
    font-size: 0.875rem;
  }

  /* Footer */
  .footer {
    border-top: 1px solid var(--border);
    padding: 4rem 2rem;
    min-height: 200px;
    display: flex;
    align-items: center;
  }

  .footer-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 2rem;
    width: 100%;
  }

  .footer-logo {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .footer-tagline {
    font-size: 0.875rem;
  }
  .footer-links {
    display: flex;
    gap: 3rem;
  }

  .footer-links a {
    color: var(--fg-muted);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  }

  .footer-links a:hover {
    color: var(--accent);
  }
  .footer-license {
    font-size: 0.75rem;
  }

  /* Responsive */
  @media (min-width: 769px) {
    .app {
      scroll-snap-type: y proximity;
    }
  }

  @media (max-width: 900px) {
    .grid-2col {
      grid-template-columns: 1fr;
      gap: 3rem;
    }
  }

  @media (max-width: 768px) {
    nav {
      top: 1rem;
      padding: 0.5rem 1rem;
      gap: 0.75rem;
      width: calc(100% - 2rem);
      justify-content: center;
    }
    nav a {
      font-size: 0.7rem;
    }
    .display-huge {
      font-size: clamp(2.5rem, 12vw, 5rem);
    }
    .display-large {
      font-size: clamp(2rem, 8vw, 3.5rem);
    }
    .bento {
      grid-template-columns: repeat(2, 1fr);
      background: var(--bg);
    }
    .bento-item-lg {
      grid-column: span 2;
    }
    .bento-item-tall {
      grid-row: span 1;
    }
    .bento-item {
      min-height: 140px;
      padding: 1.25rem;
    }
    .bento-title {
      font-size: 1.25rem;
    }
    section {
      padding: 8rem 1.25rem;
      min-height: auto;
      margin-bottom: 10rem;
    }
    .hero-section {
      padding-top: 8rem;
    }
    .terminal {
      font-size: 0.75rem;
    }
    .terminal-body {
      padding: 1rem;
    }
    .marquee-item {
      padding: 0 1.5rem;
      font-size: 1.25rem;
    }
    .marquee {
      margin-bottom: 6rem;
    }
    .scroll-hint {
      display: none;
    }
    .feature-card {
      padding: 1.5rem;
    }
    .feature-cards {
      margin-top: 4rem;
    }
    .cta-section {
      margin-top: 8rem;
      margin-bottom: 8rem;
    }
    .section-center.elevated {
      margin-bottom: 0;
      min-height: 100vh;
      padding-top: 6rem;
      padding-bottom: 6rem;
    }
    .btn {
      padding: 0.875rem 1.5rem;
      font-size: 0.875rem;
    }
    .hero-buttons {
      flex-direction: column;
      padding-right: 0;
      margin-top: 3rem;
      margin-bottom: 6rem;
    }
    .hero-buttons .btn {
      width: 100%;
      justify-content: center;
    }
    .cta-section .btn {
      width: 100%;
      font-size: 1rem;
      padding: 1rem 2rem;
    }
    .footer-content {
      flex-direction: column;
      text-align: center;
    }
    .footer-license {
      order: -1;
    }
    .stats-row {
      gap: 1.5rem;
    }
    .stat-value {
      font-size: 2rem;
    }
  }
</style>
