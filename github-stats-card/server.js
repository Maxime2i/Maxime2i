import express from "express";

const USERNAME = process.env.GITHUB_USERNAME || "Maxime2i";
const TOKEN = process.env.GITHUB_STATS_TOKEN || "";
const CODING_SINCE = process.env.CODING_SINCE || "2023";
const PORT = process.env.PORT || 3000;
const GH = "https://api.github.com";

if (!TOKEN) {
  console.error("GITHUB_STATS_TOKEN manquant");
  process.exit(1);
}

/* ---------- cache mémoire ---------- */
const cache = { stats: null, langs: null };
const TTL_STATS = 30 * 60 * 1000; // 30 min
const TTL_LANGS = 24 * 60 * 60 * 1000; // 24 h

/* ---------- helpers GitHub ---------- */
async function gh(path, accept) {
  const headers = {
    Authorization: "Bearer " + TOKEN,
    Accept: accept || "application/vnd.github+json",
    "User-Agent": "github-stats-card",
  };
  const res = await fetch(GH + path, { headers });
  if (!res.ok) throw new Error("GH " + res.status + " " + path);
  return res.json();
}

/* Total commits de l'auteur (public + privé, via search) — option date ISO */
async function fetchCommits(fromDate) {
  const q = fromDate
    ? `author:${USERNAME}+committer-date:>${fromDate}`
    : `author:${USERNAME}`;
  const d = await gh(`/search/commits?q=${q}&per_page=1`);
  return d.total_count || 0;
}

/* Events récents (max 300, limite API) pour le rythme */
async function fetchEvents() {
  let all = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/users/${USERNAME}/events?per_page=100&page=${page}`);
    if (!batch.length) break;
    all = all.concat(batch);
  }
  return all;
}

async function getStats() {
  if (cache.stats && Date.now() - cache.stats.at < TTL_STATS) return cache.stats.data;
  const events = await fetchEvents();
  const rhythm = rhythmStats(events);
  // commits totaux + commits sur la fenêtre des events
  const minDate = new Date(rhythm.minT).toISOString().slice(0, 10);
  const [totalCommits, windowCommits] = await Promise.all([
    fetchCommits(),
    fetchCommits(minDate),
  ]);
  const data = { totalCommits, windowCommits, rhythm };
  cache.stats = { at: Date.now(), data };
  return data;
}

/* Langages agrégés sur tous les repos (hors forks), privé inclus */
async function fetchLangs() {
  const repos = await gh(`/user/repos?per_page=100&affiliation=owner&sort=updated`);
  const totals = {};
  for (const repo of repos) {
    if (repo.fork) continue;
    try {
      const langs = await gh(`/repos/${repo.full_name}/languages`);
      for (const [lang, bytes] of Object.entries(langs)) {
        totals[lang] = (totals[lang] || 0) + bytes;
      }
    } catch {
      /* repo inaccessible : on continue */
    }
  }
  return totals;
}

async function getLangs() {
  if (cache.langs && Date.now() - cache.langs.at < TTL_LANGS) return cache.langs.data;
  const data = await fetchLangs();
  cache.langs = { at: Date.now(), data };
  return data;
}

/* ---------- stats ---------- */
function rhythmStats(events) {
  const pushes = events.filter((e) => e.type === "PushEvent");
  const days = new Set();
  let minT = Infinity, maxT = 0;
  for (const e of pushes) {
    const t = new Date(e.created_at).getTime();
    days.add(new Date(e.created_at).toISOString().slice(0, 10));
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  const windowDays = maxT > minT ? Math.max(1, Math.round((maxT - minT) / 86400e3)) : 1;
  return { daysOfCode: days.size, windowDays, minT, maxT };
}

const LANG_COLORS = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5",
  HTML: "#e34c26", CSS: "#563d7c", "C#": "#178600", C: "#555555",
  "C++": "#f34b7d", PHP: "#4F5D95", Kotlin: "#A97BFF", Swift: "#F05138",
  Ruby: "#701516", Luau: "#00A2FF", Dockerfile: "#384d54", Shell: "#89e051",
  Vue: "#41b883", Markdown: "#083fa1", MDX: "#083fa1", Java: "#b07219",
  Go: "#00ADD8", Rust: "#dea584", "Jupyter Notebook": "#DA5B0B",
};
function langColor(l) { return LANG_COLORS[l] || "#8b949e"; }

function fmt(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ---------- rendu SVG ---------- */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const W = 880, H = 312;

function statRows(totalCommits, windowCommits, rhythm, codingSince) {
  const r = rhythm;
  const avg = windowCommits / r.windowDays;
  const rows = [
    { emoji: "💻", label: "Total commits", val: fmt(totalCommits), sub: null },
    { emoji: "📅", label: "Coding since", val: codingSince, sub: null },
    { emoji: "⚡", label: "Avg commits / day", val: (avg >= 10 ? Math.round(avg).toString() : avg.toFixed(1)), sub: `last ${r.windowDays} days` },
    { emoji: "🔥", label: "Days of code", val: `${r.daysOfCode}/${r.windowDays}`, sub: `of the last ${r.windowDays} days` },
  ];
  return rows
    .map(
      (row, i) => `
    <g transform="translate(0, ${100 + i * 44})">
      <circle cx="30" cy="15" r="15" fill="#1f6feb" opacity="0.16"/>
      <text x="30" y="20.5" font-size="15" text-anchor="middle">${row.emoji}</text>
      <text x="60" y="14" font-size="14" fill="#c9d1d9">${esc(row.label)}</text>
      ${row.sub ? `<text x="60" y="29" font-size="11" fill="#6e7681">${esc(row.sub)}</text>` : ""}
      <text x="452" y="19" font-size="16" fill="#ffffff" font-weight="700" text-anchor="end">${row.val}</text>
    </g>`
    )
    .join("");
}

function langBlocks(langs) {
  const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 4);
  let cum = 0;
  const segs = sorted.map(([l, bytes]) => {
    const pct = (bytes / total) * 100;
    const x = (cum / 100) * 330;
    cum += pct;
    return `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0.5, (pct / 100) * 330).toFixed(1)}" height="14" fill="${langColor(l)}"/>`;
  }).join("");
  const items = sorted
    .map(
      ([l, bytes], i) => `
      <g transform="translate(0, ${34 + i * 26})">
        <rect x="0" y="1.5" width="11" height="11" rx="3" fill="${langColor(l)}"/>
        <text x="20" y="11.5" font-size="13.5" fill="#c9d1d9" font-weight="600">${esc(l)}</text>
        <text x="330" y="11.5" font-size="13.5" fill="#8b949e" font-weight="600" text-anchor="end">${((bytes / total) * 100).toFixed(1)}%</text>
      </g>`
    )
    .join("");
  return { segs, items, count: sorted.length };
}

function renderSvg(totalCommits, windowCommits, rhythm, langs) {
  const rows = statRows(totalCommits, windowCommits, rhythm, CODING_SINCE);
  const { segs, items, count } = langBlocks(langs);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <defs>
    <linearGradient id="wg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1f6feb"/><stop offset="1" stop-color="#58a6ff"/>
    </linearGradient>
    <clipPath id="round"><rect width="${W}" height="${H}" rx="16"/></clipPath>
  </defs>
  <g clip-path="url(#round)">
    <rect width="${W}" height="${H}" fill="#0d1117"/>
    <rect width="${W}" height="${H}" fill="none" stroke="#30363d" stroke-width="1.5" rx="16"/>

    <path d="M0,0 H${W} V16 Q${(W * 3) / 4},40 ${W / 2},24 Q${W / 4},8 0,30 Z" fill="url(#wg)"/>

    <text x="40" y="78" font-size="17.5" fill="#58a6ff" font-weight="700">GitHub Stats</text>
    ${rows}

    <line x1="498" y1="70" x2="498" y2="${80 + 4 * 44}" stroke="#21262d"/>

    <text x="536" y="78" font-size="17.5" fill="#58a6ff" font-weight="700">Most Used Languages</text>
    <g transform="translate(536, 100)">
      <rect width="330" height="14" rx="7" fill="#21262d"/>
      ${segs}
    </g>
    <g transform="translate(536, 140)">${items}</g>

    <path d="M0,${H} H${W} V${H - 14} Q${(W * 3) / 4},${H - 38} ${W / 2},${H - 24} Q${W / 4},${H - 10} 0,${H - 30} Z" fill="url(#wg)" opacity="0.9"/>
  </g>
</svg>`;
}

/* ---------- HTTP ---------- */
const app = express();

app.get("/card", async (req, res) => {
  try {
    const [stats, langs] = await Promise.all([getStats(), getLangs()]);
    const svg = renderSvg(stats.totalCommits, stats.windowCommits, stats.rhythm, langs);
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(svg);
  } catch (e) {
    res.status(500).setHeader("Content-Type", "text/plain").send("error: " + e.message);
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => console.log(`github-stats-card on :${PORT}`));
