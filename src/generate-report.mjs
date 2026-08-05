import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TOP_N = Number(process.env.TREND_TOP_N || 10);
const TIME_ZONE = "Asia/Shanghai";
const MIN_STARS = 5_000;
const MAX_PUSH_AGE_MONTHS = 6;
const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const REPORT_DATE = resolveReportDate(process.env.REPORT_DATE);

const boardCatalog = [
  { key: "python", label: "Python" },
  { key: "typescript", label: "TypeScript" },
];
const selectedBoardKeys = (process.env.TREND_LANGUAGES || "python,typescript").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const boards = boardCatalog.filter((board) => selectedBoardKeys.includes(board.key));
if (!boards.length) throw new Error("TREND_LANGUAGES 至少要包含 python 或 typescript。");

function resolveReportDate(input) {
  if (input && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reportingPeriod(dateString) {
  const date = new Date(`${dateString}T12:00:00+08:00`);
  if (date.getDate() === 1) return { key: "monthly", label: "This month" };
  if (date.getDay() === 0) return { key: "weekly", label: "This week" };
  return { key: "daily", label: "Today" };
}

const period = reportingPeriod(REPORT_DATE);
const headers = {
  "User-Agent": "github-trend-radar",
  Accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function fetchOrThrow(url, options = {}, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000), headers: { ...headers, ...options.headers } });
      if (response.ok) return response;
      if (response.status === 404) return response;
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`${response.status} ${response.statusText}: ${url}`);
      }
      lastError = new Error(`${response.status} ${response.statusText}: ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  throw lastError;
}

function decodeHtml(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchTrending(board) {
  const language = board.key ? `/${board.key}` : "";
  const url = `${GITHUB_WEB}/trending${language}?since=${period.key}`;
  const response = await fetchOrThrow(url, { headers: { Accept: "text/html" } });
  const html = await response.text();
  const articles = [...html.matchAll(/<article\s+class="Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g)].map((match) => match[1]);
  const projects = [];
  for (const article of articles) {
    const match = article.match(/href="\/(?!features|topics|sponsors)([\w.-]+\/[\w.-]+)"/);
    if (!match) continue;
    const name = match[1];
    const descriptionMatch = article.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const starsMatch = article.match(/([\d,]+)\s+stars?\s+today/i) || article.match(/([\d,]+)\s+stars?\s+this\s+(?:week|month)/i);
    projects.push({ name, board: board.label, rank: projects.length + 1, trendingDescription: decodeHtml(descriptionMatch?.[1]), starsPeriod: starsMatch?.[1] ?? "—" });
    if (projects.length === TOP_N) break;
  }
  if (!projects.length) throw new Error(`无法从 GitHub Trending 读取 ${board.label} 榜单。`);
  return projects;
}

async function getJson(url) {
  const response = await fetchOrThrow(url);
  return response.status === 404 ? null : response.json();
}

async function getText(url) {
  const response = await fetchOrThrow(url, { headers: { Accept: "application/vnd.github.raw+json" } });
  return response.status === 404 ? "" : response.text();
}

async function inspectProject(project) {
  const encoded = project.name.split("/").map(encodeURIComponent).join("/");
  const [repo, readme, release, issues] = await Promise.all([
    getJson(`${GITHUB_API}/repos/${encoded}`),
    getText(`${GITHUB_API}/repos/${encoded}/readme`),
    getJson(`${GITHUB_API}/repos/${encoded}/releases/latest`),
    getJson(`${GITHUB_API}/repos/${encoded}/issues?state=open&sort=updated&direction=desc&per_page=5`),
  ]);
  const realIssues = Array.isArray(issues) ? issues.filter((issue) => !issue.pull_request).slice(0, 3) : [];
  return {
    ...project,
    url: `${GITHUB_WEB}/${project.name}`,
    description: repo?.description || project.trendingDescription || "项目未提供简介。",
    homepage: repo?.homepage || "",
    license: repo?.license?.spdx_id || repo?.license?.name || "未声明（需人工确认）",
    isArchived: Boolean(repo?.archived),
    pushedAt: repo?.pushed_at || "",
    updatedAt: repo?.updated_at || "",
    openIssues: repo?.open_issues_count ?? "未知",
    stars: repo?.stargazers_count ?? "未知",
    release: release ? { tag: release.tag_name, publishedAt: release.published_at, name: release.name || "" } : null,
    recentIssues: realIssues.map((issue) => ({ title: issue.title, updatedAt: issue.updated_at, url: issue.html_url })),
    readme: readme.slice(0, 6000),
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function dateOnly(value) { return value ? value.slice(0, 10) : "未知"; }
function escapeMarkdown(value = "") { return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }

function isWithinMonths(value, months, referenceDate = REPORT_DATE) {
  if (!value) return false;
  const cutoff = new Date(`${referenceDate}T12:00:00+08:00`);
  cutoff.setMonth(cutoff.getMonth() - months);
  const target = new Date(value);
  return !Number.isNaN(target.valueOf()) && target >= cutoff;
}

function isEligibleProject(project) {
  return Number(project.stars) > MIN_STARS && isWithinMonths(project.pushedAt, MAX_PUSH_AGE_MONTHS);
}

function hasFreshRelease(project) {
  return Boolean(project.release) && isWithinMonths(project.release.publishedAt, 12);
}

function readmeSummaryFallback(readme, description) {
  const paragraphs = String(readme || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, " ")
    .replace(/^\s*[-*+]\s+.*$/gm, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 30 && !/^https?:\/\//.test(paragraph));
  const firstParagraph = paragraphs[0] || "";
  const sentences = firstParagraph.split(/(?<=[。！？.!?])\s+/).filter(Boolean).slice(0, 2).join(" ");
  return (sentences || firstParagraph).slice(0, 240) || description;
}

function heuristic(project) {
  return {
    summary: readmeSummaryFallback(project.readme, project.description),
  };
}

async function summarizeWithMiniMax(projects) {
  if (!process.env.MINIMAX_API_KEY) return new Map(projects.map((project) => [project.name, heuristic(project)]));
  const results = new Map();
  for (let index = 0; index < projects.length; index += 5) {
    const batch = projects.slice(index, index + 5);
    const input = batch.map((project) => ({
      name: project.name, description: project.description, boards: project.boards, license: project.license,
      latest_release: project.release ? `${project.release.tag} (${dateOnly(project.release.publishedAt)})` : "none",
      pushed_at: dateOnly(project.pushedAt), open_issues: project.openIssues,
      maintenance_signal: project.recentIssues.length ? `近期有 ${project.recentIssues.length} 个活跃 issue，最新更新于 ${dateOnly(project.recentIssues[0].updatedAt)}` : "未读取到近期开放 issue",
      readme_excerpt: project.readme.slice(0, 3500),
    }));
    const baseUrl = (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    console.log(`Summarizing MiniMax batch ${index / 5 + 1}/${Math.ceil(projects.length / 5)}`);
    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MINIMAX_API_KEY}` },
        body: JSON.stringify({ model: process.env.MINIMAX_MODEL || "MiniMax-M2.7", max_completion_tokens: 1200, messages: [{ role: "system", content: "你是谨慎的开源技术研究员。仅根据提供事实，用简体中文逐项目总结。summary 必须以 readme_excerpt 为主要依据，说明项目解决什么问题、核心能力和适用场景；不要复述 GitHub 趋势排名或泛泛宣传语。必须只返回一个合法 JSON 数组，不要 Markdown、代码围栏、前后说明或换行。每项只包含 name、summary。summary 为纯文本，不超过 100 个中文字符，值内不用英文双引号。" }, { role: "user", content: JSON.stringify(input) }] }),
      });
    } catch (error) {
      console.warn(`MiniMax 请求超时或连接失败（${error.message}），本批使用事实摘要。`);
      batch.forEach((project) => results.set(project.name, heuristic(project)));
      continue;
    }
    if (!response.ok) {
      console.warn(`MiniMax 总结失败（${response.status}），本批使用事实摘要。`);
      batch.forEach((project) => results.set(project.name, heuristic(project)));
      continue;
    }
    const data = await response.json();
    try {
      const content = String(data.choices?.[0]?.message?.content || "").trim();
      const start = content.indexOf("[");
      const end = content.lastIndexOf("]");
      if (start < 0 || end <= start) throw new Error("未找到 JSON 数组");
      const summaries = JSON.parse(content.slice(start, end + 1));
      for (const item of summaries) if (item.name) results.set(item.name, item);
    } catch (error) {
      console.warn(`MiniMax 返回内容无法解析（${error.message}），本批使用事实摘要。`);
    }
    batch.forEach((project) => { if (!results.has(project.name)) results.set(project.name, heuristic(project)); });
  }
  return results;
}

function renderReport(projects, summaries) {
  const byBoard = new Map(boards.map((board) => [board.label, []]));
  for (const project of projects) for (const board of project.boards) byBoard.get(board).push(project);
  const lines = [
    `# GitHub 趋势日报 · ${REPORT_DATE}`,
    "",
    `> 范围：${period.label} ｜ 时区：${TIME_ZONE} ｜ 榜单：${boards.map((board) => board.label).join("、")}（各 Top ${TOP_N}，仅保留 Stars > ${MIN_STARS} 且近 ${MAX_PUSH_AGE_MONTHS} 个月有推送的项目）`,
    "",
    "## 本次筛选",
    "",
    `- 通过质量筛选：${projects.length} 个项目。`,
    `- 条件：总 Stars > ${MIN_STARS}，且最近 ${MAX_PUSH_AGE_MONTHS} 个月有推送。`,
    "",
  ];
  for (const board of boards) {
    lines.push(`## ${board.label} Top ${TOP_N}`, "");
    for (const project of byBoard.get(board.label)) {
      const summary = summaries.get(project.name);
      const rank = project.boardRanks[board.label];
      lines.push(`### ${rank}. [${project.name}](${project.url})`, "");
      lines.push(`- **项目介绍**：${escapeMarkdown(project.description)}`);
      lines.push(`- **项目总结**：${escapeMarkdown(summary.summary)}`);
      lines.push(`- **License**：${escapeMarkdown(project.license)}`);
      lines.push(`- **事实数据**：本榜第 ${rank}；趋势增星 ${project.starsPeriod}；总 Stars ${project.stars}；最近推送 ${dateOnly(project.pushedAt)}。`);
      if (hasFreshRelease(project)) lines.push(`- **最新 Release**：${escapeMarkdown(project.release.tag)}，${dateOnly(project.release.publishedAt)}。`);
      lines.push("");
    }
  }
  lines.push("---", "", "_说明：趋势榜由 GitHub Trending 抓取；项目资料与 License 标识由 GitHub API 读取。_");
  return `${lines.join("\n")}\n`;
}

async function updateReadme(reportPath) {
  const readmePath = path.resolve("README.md");
  const readme = existsSync(readmePath) ? await readFile(readmePath, "utf8") : "# GitHub Trend Radar\n";
  const marker = "<!-- latest-report -->";
  const latest = `${marker}\n\n最新报告：[${REPORT_DATE}](${reportPath.replaceAll("\\", "/")})\n\n${marker}`;
  const pattern = new RegExp(`${marker}[\\s\\S]*?${marker}`);
  await writeFile(readmePath, pattern.test(readme) ? readme.replace(pattern, latest) : `${readme.trim()}\n\n${latest}\n`);
}

async function main() {
  console.log(`Generating ${period.label} report for ${REPORT_DATE}`);
  console.log(`Fetching ${boards.map((board) => board.label).join(" and ")} GitHub Trending boards...`);
  const rankings = await Promise.all(boards.map(fetchTrending));
  const merged = new Map();
  for (const boardProjects of rankings) for (const item of boardProjects) {
    const existing = merged.get(item.name);
    if (existing) existing.boards.push({ label: item.board, rank: item.rank });
    else merged.set(item.name, { ...item, boards: [{ label: item.board, rank: item.rank }] });
  }
  console.log(`Inspecting ${merged.size} unique repositories with concurrency 5...`);
  const inspected = await mapWithConcurrency([...merged.values()], 5, inspectProject);
  const eligibleProjects = inspected.filter(isEligibleProject);
  console.log(`Retained ${eligibleProjects.length}/${inspected.length} projects after quality filters.`);
  if (!eligibleProjects.length) throw new Error("没有项目满足 Stars 和近期推送筛选条件。");
  eligibleProjects.forEach((project) => {
    project.boardRanks = Object.fromEntries(project.boards.map((item) => [item.label, item.rank]));
    project.boards = project.boards.map((item) => item.label);
  });
  const summaries = await summarizeWithMiniMax(eligibleProjects);
  const [year, month, day] = REPORT_DATE.split("-");
  const reportPath = process.env.REPORT_OUTPUT_PATH || path.join("reports", year, month, `${day}.md`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport(eligibleProjects, summaries));
  if (!process.env.SKIP_README_UPDATE) await updateReadme(reportPath);
  console.log(`Wrote ${reportPath} for ${eligibleProjects.length} eligible projects.`);
}

export { boards, hasFreshRelease, isEligibleProject, isWithinMonths, readmeSummaryFallback, renderReport, reportingPeriod };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
