# 慢车道消费者

字幕优先(yt-dlp)→ whisper 兜底(ffmpeg + Groq)→ DeepSeek 大纲调用 → 逐章详写 + 覆盖补漏(`src/shared/notes.ts`,docs/05)→ 回程交给 Worker。
同一份代码两种跑法:**Lambda 容器**(生产,SQS 触发)和**本地进程**(联调/后备,直接长轮询 SQS)。
同一条队列还跑订阅模式的 `{kind:"discover"}` 消息(`src/discover.ts`):经代理抓 YouTube UULF RSS / B站 APP 接口 / 播客 RSS,把候选 POST 回 Worker 的 `/api/queue/candidates`,挑选在 Worker 做。

## 打包

```bash
# 在产品根目录(esbuild 走产品仓的 node_modules)
npm run build:consumer      # 产物 consumer/dist/{lambda,local,notes-bench}.mjs
```

## 详细笔记基准(改 prompt / 并发 / 思考力度前后对照)

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
node consumer/dist/notes-bench.mjs paragraphs.json     # {"title","paragraphs":[...]}
$env:BENCH_TITLE = "..."; $env:BENCH_DURATION = "3588"
node consumer/dist/notes-bench.mjs karpathy.en.vtt     # yt-dlp --write-auto-subs 拿到的 VTT
# 对照变量:NOTES_CONCURRENCY(默认 6)、NOTES_REASONING(low|none,默认 low)
```

打印每步耗时、DeepSeek 用量(`cache_hit` 是前缀缓存是否生效的仪表)与产出统计;结果落在同名 `.result.json`。
2026-08-28 Karpathy 1h 的对照:low×3 并发 575s / 7.3K 字 / 锚定 82%;none×4 并发 284s / 8.5K 字 / 锚定 69% 且出现数字错——留 low,用并发换时间。

## 本地跑(联调 / Lambda 就绪前的临时消费者)

需要本机有 `yt-dlp` 和 `ffmpeg`(PATH 里可调用)。

```powershell
$env:WORKER_BASE_URL = "https://nanisle-002-watch-router.<subdomain>.workers.dev"
$env:CONSUMER_TOKEN  = "<与 Worker secret 同值>"
$env:DEEPSEEK_API_KEY = "sk-..."
$env:QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/<acct>/nanisle-watch-router-tasks"
# SQS 凭证(仅本地模式需要;Lambda 模式由执行角色兜):
aws configure export-credentials --profile <profile> --format env-no-export | % { $p = $_ -split "=",2; Set-Item "env:$($p[0])" $p[1] }
# 可选:GROQ_API_KEY(whisper 兜底)、PROXY_URL(YouTube 住宅代理)

node consumer/dist/local.mjs
```

## 容器(生产形态)

```bash
npm run build:consumer
docker build -t watch-router-consumer consumer/
# 本地冒烟(基础镜像自带 Runtime Interface Emulator):
docker run -p 9000:8080 -e WORKER_BASE_URL=... -e CONSUMER_TOKEN=... -e DEEPSEEK_API_KEY=... watch-router-consumer
curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" -d '{"Records":[{"body":"{\"taskId\":\"t\",\"url\":\"...\",\"contentKey\":\"k\",\"platform\":\"youtube\"}"}]}'
```

生产部署走主仓私有 infra 的 CDK(`NanisleWatchRouter` 栈把占位 zip 换成
`DockerImageFunction` 指向本目录;**架构要改成 X86_64**,内存 2048、/tmp 4GB,
env 注入 `WORKER_BASE_URL/CONSUMER_TOKEN/DEEPSEEK_API_KEY/GROQ_API_KEY/PROXY_URL`)。

## 失败语义(与 docs/02 T1 一致)

- 管线内失败(没字幕又没配 Groq、下载超时、模型输出坏)→ `complete({error})` 显式上报,SQS 消息正常删除,不重试不烧钱;
- 回程本身失败 → 抛出 → SQS 按 visibility 重投,2 次后进 DLQ;
- 重投的旧消息 → 首个 progress 回包带 `done:true`,消费者直接放弃(幂等)。
