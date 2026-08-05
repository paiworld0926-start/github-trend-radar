import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const TOP_N = 10;
const TIME_ZONE = "Asia/Shanghai";
const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const REPORT_DATE = resolveReportDate(process.env.REPORT_DATE);

const boards = [
  { key: "python", label: "Python" },
  { key: "java", label: "Java" },
  { key: "typescript", label: "TypeScript" },
  { key: null, label: "全部语言" },
];

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

function heuristic(project) {
  const release = project.release ? `最近版本 ${project.release.tag} 发布于 ${dateOnly(project.release.publishedAt)}` : "未发现正式 Release";
  const issues = project.recentIssues.length ? `近期有 ${project.recentIssues.length} 个活跃 issue，最近更新于 ${dateOnly(project.recentIssues[0].updatedAt)}` : "未读取到近期开放 issue";
  return {
    summary: project.description,
    direction: `该项目在 ${project.board} 趋势榜中排名第 ${project.rank}，可作为该方向的近期信号。`,
    reuse: project.license === "MIT" || project.license === "Apache-2.0" || project.license === "BSD-3-Clause" ? "许可证通常支持商用复用；使用前仍应核对仓库 LICENSE 原文及依赖许可证。" : `许可证为 ${project.license}，复用或商用前请进行法务/许可核对。`,
    inspiration: "可从其 README 的问题定义、示例和使用路径中提炼产品或课程选题。",
    learning: `${release}；${issues}。`,
    caution: project.isArchived ? "仓库已归档，不建议作为新项目的核心依赖。" : "自动结论仅作初筛；重要采用决策请人工阅读完整 README 与 LICENSE。",
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
      recent_issues: project.recentIssues.map((issue) => `${issue.title} (${dateOnly(issue.updatedAt)})`),
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
        body: JSON.stringify({ model: process.env.MINIMAX_MODEL || "MiniMax-M2.7", max_completion_tokens: 1600, messages: [{ role: "system", content: "你是谨慎的开源技术研究员。仅根据提供事实，用简体中文逐项目总结。不要把许可证解读成法律意见；不确定时明确说明。必须只返回一个合法 JSON 数组，不要 Markdown、代码围栏、前后说明或换行。每项必须包含 name, summary, direction, reuse, inspiration, learning, caution；所有字段均为纯文本，单字段不超过 35 个中文字符，值内不用英文双引号。" }, { role: "user", content: JSON.stringify(input) }] }),
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
  const featured = projects.slice().sort((a, b) => b.boards.length - a.boards.length || Number(String(b.starsPeriod).replaceAll(",", "")) - Number(String(a.starsPeriod).replaceAll(",", ""))).slice(0, 5);
  const lines = [
    `# GitHub 趋势日报 · ${REPORT_DATE}`,
    "",
    `> 范围：${period.label} ｜ 时区：${TIME_ZONE} ｜ 榜单：Python、Java、TypeScript、全部语言（各 Top ${TOP_N}）`,
    "",
    "## 今日观察",
    "",
    `- 共采集 ${projects.length} 个去重项目；其中跨榜出现的项目优先关注。`,
    ...featured.map((project) => `- **[${project.name}](${project.url})**：${escapeMarkdown(summaries.get(project.name).summary)}`),
    "",
  ];
  for (const board of boards) {
    lines.push(`## ${board.label} Top ${TOP_N}`, "");
    for (const project of byBoard.get(board.label)) {
      const summary = summaries.get(project.name);
      const rank = project.boardRanks[board.label];
      lines.push(`### ${rank}. [${project.name}](${project.url})`, "");
      lines.push(`- **项目作用**：${escapeMarkdown(summary.summary)}`);
      lines.push(`- **趋势与方向**：${escapeMarkdown(summary.direction)}`);
      lines.push(`- **复用/商用**：${escapeMarkdown(summary.reuse)}（License：${escapeMarkdown(project.license)}）`);
      lines.push(`- **灵感**：${escapeMarkdown(summary.inspiration)}`);
      lines.push(`- **学习与维护信号**：${escapeMarkdown(summary.learning)}`);
      lines.push(`- **风险提示**：${escapeMarkdown(summary.caution)}`);
      lines.push(`- **事实数据**：本榜第 ${rank}；趋势增星 ${project.starsPeriod}；总 Stars ${project.stars}；最近推送 ${dateOnly(project.pushedAt)}；开放 Issues ${project.openIssues}。`);
      if (project.release) lines.push(`- **最新 Release**：${escapeMarkdown(project.release.tag)}，${dateOnly(project.release.publishedAt)}。`);
      if (project.recentIssues.length) lines.push(`- **近期 Issues**：${project.recentIssues.map((issue) => `[${escapeMarkdown(issue.title)}](${issue.url})`).join("；")}`);
      lines.push("");
    }
  }
  lines.push("---", "", "_说明：趋势榜由 GitHub Trending 抓取；项目资料由 GitHub API 读取。许可证结论仅为技术初筛，不构成法律意见。_");
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
  console.log("Fetching four GitHub Trending boards...");
  const rankings = await Promise.all(boards.map(fetchTrending));
  const merged = new Map();
  for (const boardProjects of rankings) for (const item of boardProjects) {
    const existing = merged.get(item.name);
    if (existing) existing.boards.push({ label: item.board, rank: item.rank });
    else merged.set(item.name, { ...item, boards: [{ label: item.board, rank: item.rank }] });
  }
  console.log(`Inspecting ${merged.size} unique repositories with concurrency 5...`);
  const inspected = await mapWithConcurrency([...merged.values()], 5, inspectProject);
  inspected.forEach((project) => {
    project.boardRanks = Object.fromEntries(project.boards.map((item) => [item.label, item.rank]));
    project.boards = project.boards.map((item) => item.label);
  });
  const summaries = await summarizeWithMiniMax(inspected);
  const [year, month, day] = REPORT_DATE.split("-");
  const reportPath = path.join("reports", year, month, `${day}.md`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport(inspected, summaries));
  await updateReadme(reportPath);
  console.log(`Wrote ${reportPath} for ${inspected.length} unique projects.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
