// Finds every GitHub Pages site of the owner, screenshots it and renders the cards into index.html.
// Run: node .github/scripts/build.mjs   (needs `playwright` installed with chromium)
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OWNER = "klmix";
const SELF = `${OWNER}.github.io`;
const ROOT = new URL("../../", import.meta.url);
const THUMBS = new URL("thumbs/", ROOT);

// Optional per-repo tweaks: { "repo": { "tags": ["..."], "hide": true, "name": "...", "desc": "...", "order": 1 } }
const overrides = JSON.parse(await readFile(new URL("projects.json", ROOT), "utf8").catch(() => "{}"));

const headers = { "User-Agent": SELF, Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const res = await fetch(`https://api.github.com/users/${OWNER}/repos?per_page=100&sort=created`, { headers });
if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
const repos = (await res.json()).filter(
  (r) => r.has_pages && !r.fork && !r.archived && r.name !== SELF && !overrides[r.name]?.hide,
);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

await mkdir(THUMBS, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 750 }, colorScheme: "dark" });
const projects = [];

for (const repo of repos) {
  const o = overrides[repo.name] ?? {};
  // GitHub redirects the default project URL to the custom domain, if one is set.
  let url = repo.homepage || `https://${SELF}/${repo.name}/`;
  try {
    // A freshly enabled site can take a minute to go live, so retry a few times.
    let r;
    for (let i = 0; i < 4; i++) {
      r = await fetch(url, { redirect: "follow" }).catch(() => null);
      if (r?.ok) break;
      await new Promise((ok) => setTimeout(ok, 30000));
    }
    if (!r) { console.warn(`skip ${repo.name}: unreachable`); continue; }
    if (!r.ok) { console.warn(`skip ${repo.name}: ${r.status}`); continue; }
    url = r.url;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: fileURLToPath(new URL(`${repo.name}.jpg`, THUMBS)), type: "jpeg", quality: 72 });
  } catch (e) {
    console.warn(`skip ${repo.name}: ${e.message}`);
    continue;
  }
  const title = (await page.title()).split(/\s[–—|·-]\s/)[0].trim();
  projects.push({
    repo: repo.name,
    url,
    name: o.name || title || repo.name,
    desc: o.desc ?? repo.description ?? "",
    tags: o.tags ?? [],
    order: o.order ?? 1000,
    created: repo.created_at,
  });
  console.log(`ok ${repo.name} -> ${url}`);
}
await browser.close();
if (!projects.length) throw new Error("no sites reachable, leaving index.html untouched");

// Remove thumbnails of sites that disappeared.
const keep = new Set(projects.map((p) => `${p.repo}.jpg`));
for (const f of await readdir(THUMBS)) if (!keep.has(f)) await unlink(new URL(f, THUMBS));

projects.sort((a, b) => a.order - b.order || b.created.localeCompare(a.created));

const cards = projects.map((p) => {
  const u = new URL(p.url);
  const sameSite = u.hostname === "rwall.de";
  const href = sameSite ? u.pathname.replace(/^\//, "") : p.url;
  const where = sameSite ? u.pathname.replace(/\/$/, "") : u.hostname + u.pathname.replace(/\/$/, "");
  const tags = p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `    <li data-tags="${esc(p.tags.join("|"))}">
      <a href="${esc(href)}">
        <span class="shot"><img src="thumbs/${esc(p.repo)}.jpg" alt="" width="1200" height="750" loading="lazy"></span>
        <span class="meta">
          <span class="text">
            <span class="name">${esc(p.name)}</span>
            <span class="desc">${esc(p.desc)}</span>
            <span class="foot"><span class="where">${esc(where)}</span>${tags}</span>
          </span>
          <span class="go" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg></span>
        </span>
      </a>
    </li>`;
}).join("\n");

const indexUrl = new URL("index.html", ROOT);
const html = await readFile(indexUrl, "utf8");
if (!html.includes("<!-- projects:start -->")) throw new Error("markers missing in index.html");
const next = html.replace(/<!-- projects:start -->[\s\S]*?<!-- projects:end -->/, `<!-- projects:start -->
${cards}
    <!-- projects:end -->`);
await writeFile(indexUrl, next);
console.log(`${projects.length} projects written`);
