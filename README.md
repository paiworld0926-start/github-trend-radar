# GitHub Trend Radar

每天北京时间 09:00 自动生成 GitHub 趋势报告，并提交到本仓库的 [`reports/`](reports/) 目录。

## 榜单规则

- 每月 1 日：读取 GitHub Trending 的 `This month`。
- 其他周日：读取 `This week`。
- 其他日期：读取 `Today`。
- 分别采集 Python、Java、TypeScript 和全部语言榜单的 Top 10。
- 跨榜重复项目只分析一次，并在报告中标注其来源榜单。

每个项目会审查 README、License、最新 Release 和近期 Issues，并归纳技术方向、可复用性、产品/课程灵感与学习价值。

## 配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中新增：

| 类型 | 名称 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| Secret | `OPENAI_API_KEY` | 推荐 | 用于生成中文分析。未配置时仍会生成结构化事实报告。 |
| Variable | `OPENAI_MODEL` | 可选 | 默认 `gpt-5-mini`；可改为你账户可用的模型。 |

`GITHUB_TOKEN` 由 Actions 自动提供，用来读取项目数据和提交报告，无需手工创建。工作流已声明 `contents: write` 权限。

## 手动运行

进入仓库的 **Actions → Generate GitHub trend report → Run workflow**。可选填 `report_date` 重跑某一天；这对验证部署很方便。

## 报告格式

每日报告位于 `reports/YYYY/MM/DD.md`。运行完成后，首页会自动更新最新报告链接。
