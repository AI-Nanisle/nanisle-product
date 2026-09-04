# nanisle-product

[English](README.md) | **中文**

**每周做一个小产品，全部开源。** 每个产品验证一个真实需求，第一版不超过 8 小时，都放在 [nanisle.com](https://nanisle.com) 上——每发布一个产品，海图上多一座岛。

## 产品目录

| # | 产品 | 一句话 | Demo | 源码 |
|---|------|--------|------|------|
| 001 | 每日简报 Daily Brief | 有限、有终点的每日简报,每条都是通往原文的路由器 | _即将上线_ | [products/001-daily-brief](products/001-daily-brief/) |
| 002 | 长视频总结 Watch Router | 一小时的视频 AI 先替你看完:判决、带原文实证的要点、能跳回原片的分段地图 | _开发中_ | [products/002-watch-router](products/002-watch-router/) |
| 003 | 领域拆解 Weekly Teardown | 给一句话,每周一早收到 5 个候选开源项目和与上一周的差异;点一个才跑深度拆解,每句判断都挂着能点回源码某一行的永久链接 | _开发中_ | [products/003-weekly-teardown](products/003-weekly-teardown/) |

## 三条原则

1. **拿走就能跑。** 每个产品是一个自包含目录：把文件夹拷出去，`npm install`、`npm run dev`，零配置直接跑（默认 mock 模式，不需要任何 key）；想要真 AI，填自己的 Anthropic API key 就行。方便 fork 和二次开发本身就是设计目标。
2. **能用的最小版本。** 第一版 ≤8 小时，先解决作者自己的需求。这里是 MVP，不是平台。
3. **仓库里永远没有 token。** 托管 demo 跑在作者自己的 AI 订阅上，由私有网关管预算和限速。本仓库不含任何凭证、任何私有基建——边界见 [docs/ai-access.md](docs/ai-access.md) 和 [SECURITY.md](SECURITY.md)。

## 仓库结构

```text
products/           每周一个产品：NNN-slug/（自包含，不共享代码）
templates/
  web-app/          起步模板：React + Hono on Cloudflare Workers，AI 接缝已内置
docs/
  conventions.md    每周产品怎么造、怎么发
  ai-access.md      产品怎么调 AI：mock / 自带 key / 网关，以及防刷设计
```

产品之间刻意不共享 workspace、不互相 import。重复没关系，耦合才要命——这样每个目录都能独立拷走。

## 跑任意一个产品

```bash
cd products/NNN-whatever   # 或 templates/web-app
npm install                # 需要 Node.js ≥ 22
npm run dev                # mock 模式，不需要任何 key
```

想要真 AI？把自己的 key 写进 `.dev.vars`（从 `.dev.vars.example` 复制）：

```ini
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-你自己的key
```

把你的副本部署到 Cloudflare Workers（免费档就够）：

```bash
npx wrangler login
npm run deploy
```

完整说明（包括把产品指向任意 Anthropic 兼容网关，比如 [LiteLLM](https://docs.litellm.ai/docs/proxy/virtual_keys)）：[docs/ai-access.md](docs/ai-access.md)。

## 为什么托管 demo 要访问码

nanisle.com 上的 demo 跑在作者自己的 AI 订阅上。为了让它们一直活着（而不是被脚本刷爆），AI 接口设了访问码门禁，私有网关另有硬性预算上限。用自己的 key 跑自己的副本，没有这道门。

## 许可

[MIT](LICENSE)。随便用、随便改、拿去卖都行——署名感谢，但不强求。
