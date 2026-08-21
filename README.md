# GitHub Trend Radar

每天北京时间 09:00 自动生成 GitHub 趋势报告，并提交到本仓库的 [`reports/`](reports/) 目录。

## 榜单规则

- 每月 1 日：读取 GitHub Trending 的 `This month`。
- 其他周日：读取 `This week`。
- 其他日期：读取 `Today`。
- 采集 Python 与 TypeScript Trending 页面当前展示的全部项目。
- 跨榜重复项目只分析一次，并在报告中标注其来源榜单。
- 仅保留总 Stars 超过 5,000、且最近推送不超过 6 个月的项目。

每个项目会读取项目详情和 README，输出项目介绍、README 总结，以及“项目是什么、为什么需要、下一步可以应用到哪里”的延伸分析。超过 1 年的 Release 和逐条 Issues 不会出现在报告中。

## 配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中新增：

| 类型 | 名称 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| Secret | `MINIMAX_API_KEY` | 推荐 | MiniMax 的 API Key，用于生成中文分析。未配置时仍会生成结构化事实报告。 |
| Variable | `MINIMAX_MODEL` | 可选 | 默认 `MiniMax-M2.7`；可改为你账户可用的文本模型。 |
| Variable | `MINIMAX_BASE_URL` | 可选 | 默认 `https://api.minimaxi.com/v1`。如使用国际站，可改为其提供的地址。 |

`GITHUB_TOKEN` 由 Actions 自动提供，用来读取项目数据和提交报告，无需手工创建。工作流已声明 `contents: write` 权限。

## 手动运行

进入仓库的 **Actions → Generate GitHub trend report → Run workflow**。可选填 `report_date` 重跑某一天；这对验证部署很方便。

## 本地测试 MiniMax 总结

将 `.env.example` 复制为 `.env`，只在 `.env` 中填写 `MINIMAX_API_KEY`，然后运行：

```bash
npm run report:local
```

默认本地配置只抓 Python Top 5，并将测试报告写到 `reports/test-python-top5.md`；不会更新 README，也不会提交或推送任何内容。`.env` 已被 Git 忽略，禁止提交真实密钥。

## 报告格式

每日报告位于 `reports/YYYY/MM/DD.md`。运行完成后，首页会自动更新最新报告链接。

<!-- latest-report -->

最新报告：[2026-08-21](reports/2026/08/21.md)

<!-- latest-report -->
