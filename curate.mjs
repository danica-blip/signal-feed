// The Signal — weekly curation script
// Runs on GitHub Actions every Monday. Calls the Anthropic API with web
// search, curates 6 thought leadership pieces, writes docs/digest.json.
// Requires: Node 20+, ANTHROPIC_API_KEY environment variable.

import { writeFileSync, mkdirSync } from "node:fs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const today = new Date().toLocaleDateString("en-CA", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const PROMPT = `Today is ${today}. You are a curation agent for a senior product and marketing leader (enterprise martech, advertising production, AI product strategy).

Search the web for the strongest THOUGHT LEADERSHIP published in roughly the last 7 days across three areas: (1) AI strategy and applied AI, (2) product management and product leadership, (3) marketing technology and advertising/adtech.

PRIORITY SOURCES, the reader's trusted publications. Search these first and favor them when quality is comparable: Ad Age (adage.com), Adweek (adweek.com), Digiday (digiday.com), LBBOnline (lbbonline.com), ANA (ana.net), Forbes CMO Network (forbes.com/cmo-network), MARTECH.org (martech.org), Marketing Dive (marketingdive.com). At least 3 of the 6 picks should come from these when strong pieces exist there this week.

Quality bar, include only pieces that are:
- Substantive essays, analyses, or original research from credible practitioners, operators, analysts, or respected publications. Beyond the priority sources, also consider: Stratechery, Lenny's Newsletter, Reforge, a16z, HBR, Benedict Evans, company engineering and product blogs with real depth, serious trade analysis
- Carrying an actual argument or insight, not news recaps

Exclude: press releases, funding announcements, listicles, SEO content farms, vendor product promos, paywalled-beyond-headline pieces if a strong open alternative exists.

Perform 4 distinct searches covering the priority sources and all three subject areas, then pick the 6 best pieces overall, ranked by how much they'd sharpen the thinking of a product/marketing executive.

OUTPUT RULES, your reply is parsed by a machine:
- Write NO text before, between, or after searches.
- Your ONLY text output is one raw JSON array. No markdown fences.

Each element:
{
  "title": "exact article title",
  "author": "author or publication if no byline",
  "source": "publication name",
  "url": "direct link",
  "category": "AI" | "Product" | "Martech & AdTech",
  "summary": "2 sentences, your own words, what the piece argues",
  "whyItMatters": "1 sharp sentence on why a product/marketing leader should care this week"
}`;

async function callApi() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: PROMPT }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || data.error.type);
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function validArticle(a) {
  return (
    a &&
    typeof a === "object" &&
    typeof a.title === "string" &&
    typeof a.url === "string" &&
    a.title.length > 0 &&
    a.url.startsWith("http")
  );
}

// Recovers complete article objects even if the response is imperfect.
function salvageArticles(raw) {
  const clean = String(raw || "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[");
  if (start === -1) return [];
  const end = clean.lastIndexOf("]");
  if (end > start) {
    try {
      const arr = JSON.parse(clean.slice(start, end + 1));
      if (Array.isArray(arr)) return arr.filter(validArticle);
    } catch {}
  }
  const out = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) objStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          const obj = JSON.parse(clean.slice(objStart, i + 1));
          if (validArticle(obj)) out.push(obj);
        } catch {}
        objStart = -1;
      }
    }
  }
  return out;
}

function weekLabel() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 6);
  const fmt = (d) => d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  return `${fmt(start)} to ${fmt(now)}, ${now.getFullYear()}`;
}

const MAX_ATTEMPTS = 3;
let articles = [];
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    console.log(`Attempt ${attempt}…`);
    const text = await callApi();
    articles = salvageArticles(text);
    if (articles.length >= 4) break;
    console.warn(`Only recovered ${articles.length} articles, retrying.`);
  } catch (e) {
    console.error(`Attempt ${attempt} failed: ${e.message}`);
    if (attempt === MAX_ATTEMPTS) process.exit(1);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

if (articles.length === 0) {
  console.error("No articles recovered after all attempts.");
  process.exit(1);
}

const digest = {
  weekOf: weekLabel(),
  generatedAt: new Date().toISOString(),
  articles: articles.slice(0, 6),
};

mkdirSync("docs", { recursive: true });
writeFileSync("docs/digest.json", JSON.stringify(digest, null, 2));
console.log(`Wrote docs/digest.json with ${digest.articles.length} articles.`);
