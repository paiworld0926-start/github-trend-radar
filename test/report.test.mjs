import assert from "node:assert/strict";
import test from "node:test";
import { boards, hasFreshRelease, isEligibleProject, readmeSummaryFallback, renderReport } from "../src/generate-report.mjs";

test("只保留 Python 与 TypeScript 榜单", () => {
  assert.deepEqual(boards.map((board) => board.label), ["Python", "TypeScript"]);
});

test("质量筛选要求 Stars 超过 5000 且半年内有推送", () => {
  assert.equal(isEligibleProject({ stars: 5001, pushedAt: "2026-06-01T00:00:00Z" }), true);
  assert.equal(isEligibleProject({ stars: 5000, pushedAt: "2026-06-01T00:00:00Z" }), false);
  assert.equal(isEligibleProject({ stars: 9000, pushedAt: "2025-12-01T00:00:00Z" }), false);
});

test("报告不展示过期 Release 与 Issues", () => {
  const project = {
    name: "example/project", url: "https://github.com/example/project", description: "项目介绍文本", boards: ["Python"], boardRanks: { Python: 1 },
    starsPeriod: "123", stars: 9000, pushedAt: "2026-06-01T00:00:00Z", openIssues: 10,
    release: { tag: "v1.0.0", publishedAt: "2024-01-01T00:00:00Z" }, recentIssues: [{ title: "not shown" }],
  };
  const summary = new Map([[project.name, { summary: "基于 README 的项目总结" }]]);
  const report = renderReport([project], summary);
  assert.equal(hasFreshRelease(project), false);
  assert.match(report, /项目介绍.*项目介绍文本/);
  assert.match(report, /项目总结.*基于 README 的项目总结/);
  assert.doesNotMatch(report, /项目作用|技术方向|最新 Release|近期 Issues|not shown|复用\/商用|灵感|学习与维护信号|风险提示/);
});

test("无模型时从 README 提取项目总结，而非 GitHub 简介", () => {
  const summary = readmeSummaryFallback("# 标题\n\n这是 README 中对项目核心能力的具体说明，提供可编程的视频编辑工作流。", "短简介");
  assert.match(summary, /README 中对项目核心能力/);
  assert.doesNotMatch(summary, /短简介/);
});
