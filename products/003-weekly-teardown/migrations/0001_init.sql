-- 003 领域拆解 · 初始 schema(docs/02-技术方案.md 决策 T2「存储用 Cloudflare D1」)。
--
-- 应用方式(人工门,不由 agent 执行):
--   wrangler d1 migrations apply nanisle-weekly-teardown --local
--   wrangler d1 migrations apply nanisle-weekly-teardown --remote
--
-- 时间戳口径:统一 INTEGER 毫秒(Date.now())。**两个例外**是 pushed_at 和
-- repo_created_at —— 它们直接存 GitHub 返回的 ISO 字符串原文,不做转换。
-- 理由是这两个值要原样回显给用户看(排除理由里那句「最后一次 push 在 2024-07」),
-- 转成毫秒再转回来只会引入时区解释的机会,而我们并不需要拿它们做算术
-- (停更判定只比大小,ISO 8601 的字典序就是时间序)。
--
-- 布尔用 INTEGER 0/1(SQLite 没有 BOOLEAN);JSON 数组用 TEXT 存 JSON.stringify。

-- 用户那份可见可改的关注定义。v1 每人一份(user_email UNIQUE),
-- 想跟踪第二个领域时再拆这条约束(docs/02「开放问题」)。
CREATE TABLE dossier (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL UNIQUE,   -- v1 每人一份档案
  sentence     TEXT NOT NULL,          -- 用户原话,AI 永不改写
  domain       TEXT NOT NULL,
  cares_about      TEXT NOT NULL,      -- JSON string[],<=5
  not_cares_about  TEXT NOT NULL,      -- JSON string[],<=5
  queries      TEXT NOT NULL,          -- JSON string[],5-8 条
  rev          INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 一周一行的周扫快照。四个计数字段(returned/admitted/excluded/fetch_failed)
-- 就是页面顶部那句诚实声明的数据来源:全部由代码统计,模型不接触
-- (沿用 001 types.ts 那条家法:computed in code, never written by the model)。
CREATE TABLE weekly_scan (
  -- 确定性 id:`${dossier_id}#${week_of}`(store.ts 的 weeklyScanId)。不是随机 id。
  -- 理由是并发正确性:id 算得出来,重跑就不必先查一次库认出旧行,那次查询也就
  -- 不会落在 batch 事务之外——「删旧子行 + 覆盖台账 + 重灌新子行」得以整体原子。
  -- 靠查库复用旧 id 的写法会让两趟并发重扫把台账和候选拆散(store.ts putWeeklyScan
  -- 的注释里有完整的交错时序)。
  id            TEXT PRIMARY KEY,
  dossier_id    TEXT NOT NULL,
  week_of       TEXT NOT NULL,          -- "2026-W36",字典序即时间序
  dossier_rev   INTEGER NOT NULL,       -- 基于哪一版档案跑的
  queries       TEXT NOT NULL,          -- 当周**实际发出**的检索词原文(JSON)
  returned      INTEGER NOT NULL,       -- 台账四数:以下全部由代码统计
  admitted      INTEGER NOT NULL,
  excluded      INTEGER NOT NULL,
  fetch_failed  INTEGER NOT NULL,
  -- 下面三列是「刷新之后那句诚实声明还说得出口」所必需的(2026-09-01 阶段 4/5
  -- 评审)。在这之前它们只挂在 POST 响应上:被截断的那一趟刷新一次,queryCount
  -- 从诚实的 7 变回档案里的 8、claimedTotal 掉成 0、stopped 整个消失,页面把一份
  -- 残缺扫描渲染成正常结果 —— 正是 docs/01 风险 1 说的「错得很安静」。
  route_count   INTEGER NOT NULL,       -- 这一趟实际用了几种排序(双路 = 2)
  claimed_total INTEGER NOT NULL,       -- GitHub 报的匹配总数(取各条词的最大值,不是求和)
  stopped       TEXT,                   -- 提前收工的原因;NULL = 全部跑完了
  created_at    INTEGER NOT NULL
);
-- cron 重跑幂等:同一个 (档案, 周) 只能有一行。cron 失败重试、站长手动补跑、
-- 用户改档案后重扫,全部落在同一行上覆盖,而不是堆出几份互相矛盾的台账。
-- 顺带也是「按 dossier_id 查 scan」和「ORDER BY week_of DESC 取最近 n 周」
-- 的索引 —— dossier_id 是最左列,不需要再建一条。
CREATE UNIQUE INDEX ux_scan ON weekly_scan(dossier_id, week_of);

-- 进了候选清单的仓。每一行都是真的 GET /repos/{o}/{r} 拿到 200 的
-- (docs/02「门 1:结构性防捏造」),抓不通的计入 weekly_scan.fetch_failed 但不落这张表。
CREATE TABLE scan_candidate (
  scan_id         TEXT NOT NULL,
  full_name       TEXT NOT NULL,        -- "owner/repo"
  stars           INTEGER NOT NULL,
  pushed_at       TEXT NOT NULL,
  archived        INTEGER NOT NULL,     -- 0/1
  license         TEXT,                 -- SPDX id,无许可证为 NULL
  repo_created_at TEXT NOT NULL,
  one_liner       TEXT,                 -- 唯一一处模型产出,且只是描述不是判断
  -- GitHub 自己给这个仓打的主题词,JSON string[]("[]" = 一个都没有)。
  --
  -- 加它的理由是**决策 8 的第一条规则现在连主语都没有**(2026-09-01 上线前终审):
  -- 「某个 topic 连续 N 周进清单且点击数为 0 → 建议把它从 caresAbout 里去掉」,
  -- 而库里从来没有 topic 这个东西。这不是一列可以将来再补的字段:补列本身
  -- 0002 就能干,补**历史**不行 —— 那条规则要的是「连续 N 周」,而历史只能从
  -- 落库的那一周开始攒。
  --
  -- 不多花任何代价:GithubRepo.topics 在 scan.ts 里已经拿在手上(one-liner
  -- 的提示词就是用它拼的),存下来不用多打一次 API。
  topics          TEXT NOT NULL,
  -- 'stars' | 'updated' | 'both' | 'appealed'(docs/02 决策 T3 的双路检索,
  -- 外加 shared/types.ts SourceRoute 那第四个值)。台账分栏靠它:
  -- 读者要看得见哪些是 sort=updated 那一路捞回来的「新冒出来的」,
  -- 按 star 排序会系统性漏掉新项目,而新项目恰恰是周更场景最该出现的东西。
  -- **'appealed' 不是一条检索路**,是「这个仓不是搜出来的,是你自己捞回来的」
  -- ——申诉那条路根本不知道当初是哪一路发现了它,填另外三个值里的任何一个
  -- 都是在库里写一件我们并不知道的事。这四个值一个都不能少写在这里:
  -- 冻结之后,一句漏了取值的注释就是一句永久错的注释。
  source_route    TEXT NOT NULL,
  "rank"          INTEGER NOT NULL,     -- 加引号:rank 在 SQLite 里是窗口函数名,别赌解析器心情
  PRIMARY KEY (scan_id, full_name)
);

-- 被筛掉的仓 + 理由。产品方案决策 4 要求这张清单和候选清单一样显眼。
CREATE TABLE scan_exclusion (
  scan_id       TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  reason        TEXT NOT NULL,          -- 给人读的中文理由,**只负责显示**
  -- 给机器读的分组键(shared/types.ts 的 ExclusionKind):
  --   archived / stale / copyleft / no-license / tiny / ranked-out / not-reached / model
  -- 加这一列的理由(2026-09-01 阶段 4/5 评审):第一屏要把 293-386 条排除按类型
  -- 分组,而在这之前分组只能去**解析上面那句中文文案**——文案改一个字,一大批
  -- 条目就集体掉进「其他」组,不报错、不崩、页面照样好看。历史行没法回填(要
  -- 重扫),所以趁库里还没有真实历史的时候加。
  reason_kind   TEXT NOT NULL,
  -- 'rule' | 'model'。UI 分色依据:规则筛掉的(archived / pushed_at / license /
  -- star 数)是可核对的客观字段,模型筛掉的(形态不同、目标用户不同)是判断。
  -- 混成一色等于让读者把判断当事实读。
  reason_source TEXT NOT NULL,
  -- 申诉时间戳,非空 = 站长捞回过。**正本不在这里**(2026-09-01 上线前终审):
  -- putWeeklyScan 每次重跑先 DELETE 掉这张表的整批子行,所以这一列只记得
  -- 「在没被重跑覆盖过的那些周里」发生过的申诉。永久台账是 scan_appeal 那张表,
  -- 这一列是它在这一周这一份清单上的投影(重跑之后由 putWeeklyScan 重新盖上)。
  appealed_at   INTEGER,
  -- 这个仓最后一次 push 的时刻(GitHub 返回的 ISO 原文,口径同 scan_candidate)。
  --
  -- 排除行为什么也要存它(2026-09-01 上线前终审):`scan_candidate` 一周只装 ≤5 个,
  -- 于是「停更断崖」那条将来要做的规则(连续 N 周一次提交都没有)在**最该被它抓到
  -- 的那类项目上永远攒不出历史** —— 一个开始停更的小项目会先掉出前 5,它的
  -- pushed_at 历史恰好断在它开始停更的那一刻。排除行每周有 ~385 条,数据本来
  -- 就在手上(规则层判 stale 用的就是它),多存一列不多打一次 API。
  --
  -- **残留的限制要一起写清楚**:这份历史仍然有洞 —— 一个仓这一周压根没被 search
  -- 返回(排名掉出 1000 条上限 / 这一趟提前收工),它这一周就一行都没有。所以
  -- 那条规则的判据只能是「有记录的那几周里连续没动过」,不能是「连续 N 周」的
  -- 字面意思;不区分的话,一个「我们没看见」的星期会被读成「它没提交」。
  pushed_at     TEXT NOT NULL,
  PRIMARY KEY (scan_id, full_name)
);

-- 深度报告。整份 payload 存 JSON blob 不做规范化(docs/02「两处设计取舍」):
-- 003 里没有「按证据查」这个场景,basedOn 的校验发生在生成时的确定性拼装阶段,
-- 落库时无依据的 takeaway 已经被丢掉了,存进去的必然自洽。拆表只多一次 join。
CREATE TABLE report (
  id             TEXT PRIMARY KEY,
  dossier_id     TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,         -- 永久回链的锚点
  -- 基于哪一版档案跑的。**它是去重键的一部分**:档案改过之后 caresAboutIndex
  -- 指的就是另一批条目了,同一个仓值得重跑一次(站长 2026-09-01 拍板)。
  dossier_rev    INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,         -- 整份报告,见上方取舍
  est_usd        REAL NOT NULL,
  anchored_ratio REAL NOT NULL,         -- 锚定成功率,产品要在页面上公开
  created_at     INTEGER NOT NULL
);
-- 「这个仓最近一次的报告是哪一份」——store.ts 的 latestReport(第一屏那个
-- 「上次拆的结果」入口),条件是 dossier_id + full_name,排序是 created_at DESC。
--
-- 这条索引原来写的是 `(dossier_id, created_at DESC)`,注释说它服务「这个档案
-- 最近跑过哪些报告,倒序翻页」——**那个消费者不存在**(2026-09-01 上线前终审
-- 搜过全仓,零命中)。而真正在跑 `ORDER BY created_at DESC` 的 latestReport
-- 用不上它:最左列匹配到 dossier_id 之后,full_name 的等值条件落在索引外面,
-- 数据库只能把这个档案的全部报告行拉出来再过滤。索引跟着真实查询走。
CREATE INDEX ix_report_latest ON report(dossier_id, full_name, created_at DESC);
-- findReport 的去重口径:同一个 commit + 同一版档案跑过就直接复用,
-- 别再烧一次 $0.4-0.6。dossier_rev 在键里的理由见 store.ts findReport。
CREATE INDEX ix_report_commit ON report(dossier_id, full_name, commit_sha, dossier_rev);

-- 在跑的那一单。一人同时至多一趟,所以 user_email 直接当主键。
-- 存在的理由只有一个:002 踩过「刷新丢进度」——浏览器内存里的转圈撑不过一次
-- 刷新,进度不落库的话 SSE 断线之后就没有东西可以接回。
CREATE TABLE inflight (
  user_email TEXT PRIMARY KEY,          -- 一人同时至多一趟
  full_name  TEXT NOT NULL,
  phase      TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 每日次数配额。主键三元组就是 reserveQuota 那句原子 upsert 的冲突目标,
-- 换主键等于换掉整个占位语义(见 shared/store.ts 的 reserveQuota 注释)。
CREATE TABLE quota (
  subject TEXT NOT NULL,                -- email 或 'ip#1.2.3.4'
  day     TEXT NOT NULL,                -- "2026-09-01"(UTC)
  kind    TEXT NOT NULL,                -- 'gen' | 'ai'
  used    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day, kind)
);
-- sweepExpired 的 `DELETE FROM quota WHERE day < ?` 用的(2026-09-01 上线前终审)。
-- 主键是 (subject, day, kind),day 不是最左列,所以那条 DELETE 走的是**全表扫**
-- ——而 quota 是全站最热的写入表,正好是最不该被全表扫的那一张。它一周才跑一次,
-- 今天扫一张小表没人看得出来,但这条索引的成本同样看不出来,而且它是一次性的。
CREATE INDEX ix_quota_day ON quota(day);

-- 全局花费闸(docs/02 决策 T6),本仓第一个。一天一行,全体用户合计。
-- 记的是**预估**值不是实付值,因为它必须在跑之前占位 —— 跑完才记账的话,
-- 10 个并发请求会同时看到「今天才花了 $0.1」然后一起放行。
CREATE TABLE daily_spend (
  day     TEXT PRIMARY KEY,
  est_usd REAL NOT NULL DEFAULT 0
);

-- 门铃邮件的发信台账(阶段 8)。**一行 = 一封本该发出去的信**,主键就是那一周
-- 那个档案的 scan_id —— 也就是说「这一周这个人发没发过」是一次主键冲突,不是
-- 一次 SELECT 之后的判断。
--
-- 为什么必须是主键而不是 weekly_scan 上的一列:cron 会重试(Cloudflare 的定时
-- 触发器失败会再打一次),而 `SELECT emailed_at → 如果为空就发 → UPDATE` 是
-- 这个仓从 store.ts 第一行注释起就在防的那种写法 —— 两趟重试交错进来,两个人
-- 都读到「还没发过」,信就发两封。这里改成 `INSERT ... ON CONFLICT DO NOTHING
-- RETURNING`:抢到行的那一趟才发信,没抢到的直接跳过,判断和写入是同一条语句。
--
-- 也不能挂在 weekly_scan 上:那张表被 putWeeklyScan 整行 upsert(重跑要把台账
-- 和 stopped 一起覆盖),多一列「不许被覆盖」的例外,迟早在某次改 SET 列表时
-- 被顺手覆盖掉,而症状是「重扫一次就又发一封信」。
--
-- sent_at 为 NULL = 认领了但没发成(SES 报错)。**这一行不会被删掉,所以这一周
-- 不会再发第二次**,理由写在 worker/cron.ts 的 sendDoorbell 里(丢一封 vs 发两封,
-- 我们选丢一封 —— 清单本来就在网页上,邮件只是门铃)。
CREATE TABLE weekly_email (
  scan_id    TEXT PRIMARY KEY,          -- = weeklyScanId(dossier_id, week_of)
  dossier_id TEXT NOT NULL,
  week_of    TEXT NOT NULL,
  user_email TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,          -- 抢到这一行的时刻
  sent_at    INTEGER,                   -- NULL = 认领了但 SES 没发成
  error      TEXT                       -- 发失败时的原因,给站长看
);

-- 一键退订名单。退订只关掉**邮件**,周扫照跑、网页照常能看 —— 退订的是门铃,
-- 不是产品。免登录(HMAC token 认身份),所以只存邮箱和时刻,没有别的东西。
CREATE TABLE email_optout (
  user_email TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2026-09-01 上线前终审加的三张表(migrations 还没 apply --remote 过,所以直接
-- 改这一份而不是叠 0002)。三张表的共同性质:**列 0002 能加,历史不能**。
-- ---------------------------------------------------------------------------

-- 跨周变化的落库(站长 2026-09-01 拍板)。**一周一行,主键和 weekly_scan 同键。**
--
-- 为什么必须落库:在这之前,跨周 diff 算完之后只进了**一封可能发不出去的邮件**,
-- 库里一个字都没有。本地库里就躺着实物 —— `weekly_email` 里一行
-- `sent_at = NULL, error = 'SES send failed (HTTP 403)'`。按阶段 8 定下的取舍
-- (认领行不删、不重试),那一周的门铃永远不会补发,于是那一趟的候选换血和
-- 复查结论**全丢了**,而 D1 里没有任何地方留下过它们。
--
-- 连带后果更重:docs/01 风险 4 的判据是「如果站长从不去翻上一周的结果,就该退回
-- skill 形态」——而产品里**没有「翻上一周」这个动作可翻**。跨周状态是这个产品
-- 相对一个 Claude Code skill 的全部存在理由(docs/01「为什么不做成 skill」),
-- 它却是唯一一样不落库的东西。
--
-- **网页和邮件读同一份**(家法同 shared/types.ts 的 ScanHonesty:后端把数字算好,
-- 前端只拼字不算数)。所以这里存的不是「够画一个页面的东西」,是那份 WeekDiff
-- 本身:网页不重算一遍 diff,邮件也不重算一遍,两边不可能对不上。
CREATE TABLE weekly_change (
  -- = weeklyScanId(dossier_id, week_of),和 weekly_scan 同键。确定性 id 的
  -- 全部理由见 weekly_scan.id 那段注释;这里额外还有一条:一周一行是这张表
  -- 想要的语义,而主键就是这条约束本身(重跑覆盖,不堆两份互相矛盾的结论)。
  scan_id           TEXT PRIMARY KEY,
  dossier_id        TEXT NOT NULL,
  week_of           TEXT NOT NULL,
  -- 拿来比的是哪一周。**可空**:第一周没有上一周,那时四类结果全空、changed=0。
  -- 取的是「除本周之外最新的那一条」而不是「本周减 7 天」(cron 挂过一周、或者
  -- 这个人上上周才建的档,中间就会有空档),所以它是一个真实存在的 week_of。
  prev_week_of      TEXT,
  -- diff 的四类结果,各存**条数**。明细在 changes_json 里。
  --
  -- 为什么条数要单独成列:决策 8 的规则要按周聚合(「连续 N 周没有任何变化」
  -- 这类判断),而聚合不该去解析每一周那几 KB 的 JSON。**列是给 SQL 用的,
  -- 渲染读 changes_json 那一份**;两边不会分叉,因为写入只有 putWeeklyChange
  -- 一个函数,它从同一个 WeekDiff 同时算出这几列和那段 JSON(调用方给不了
  -- 一组自相矛盾的数)。
  appeared_count    INTEGER NOT NULL,   -- 本周新进清单
  archived_count    INTEGER NOT NULL,   -- 由活转归档
  license_count     INTEGER NOT NULL,   -- 换了许可证
  star_jump_count   INTEGER NOT NULL,   -- star 跃迁(阈值见 scan-diff.ts)
  -- 复查(阶段 9)那三个数。**checked 的口径是「本该查几个」**(= 上一周清单的
  -- 长度),不是「查成了几个」:后者会让 GitHub 全挂的那一周落库成
  -- 「复查了 0 个,0 个有变化」——字面全对,读起来是「一切正常」。
  recheck_checked   INTEGER NOT NULL,
  recheck_changed   INTEGER NOT NULL,
  recheck_unchecked INTEGER NOT NULL,
  -- 0/1。**不是「四类条数之和 > 0」的冗余**:复查报出来的变化(归档 / 换许可证 /
  -- 仓没了)不进上面四栏,漏掉它的话,一个「上周那个仓这周归档了、别的什么都
  -- 没动」的星期会被算成「没有变化」,而那正是复查这一整条改动要报的事。
  changed           INTEGER NOT NULL,
  -- 整份 WeekDiff 的 JSON(明细:哪几个仓、从什么变成什么、复查逐条的结局)。
  -- 存 blob 不做规范化,理由同 report.payload_json:003 里没有「按变化查」这个
  -- 场景,而拆表只多一次 join。解析不了时读取侧当这一行不存在并 console.error
  -- (同 report.ts parseStored 的处置:宁可说没有,不要拿一半的明细配一组
  --  完整的计数去画页面)。
  changes_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
-- 「这个档案最近几周分别有没有变化」——翻上一周那一屏的读路径,以及将来
-- 决策 8 的规则做按周聚合时的入口。dossier_id 是最左列,week_of 倒序。
CREATE INDEX ix_change_recent ON weekly_change(dossier_id, week_of DESC);

-- 申诉的永久台账(站长 2026-09-01 拍板)。一次申诉一行,**只增不改**。
--
-- 为什么不能只靠 scan_exclusion.appealed_at:`putWeeklyScan` 每次重跑的第一件事
-- 就是 `DELETE FROM scan_exclusion WHERE scan_id = ?`,而 scan_id 是
-- (dossier_id, week_of) 算出来的 —— 同一周必然撞上。于是那一列能数出来的只有
-- 「在没被重跑覆盖过的那些周里」发生过的申诉,而决策 8 的第三条规则
-- (「某个被排除的仓被站长申诉过两次」)数的正是跨周的次数。
--
-- 这张表还顺带修掉一个 bug(2026-09-01 上线前终审的 A2):重跑之后,
-- runWeeklyScan 从这里读回这一周申诉过的仓名,把它们重新搬进候选清单
-- ——在这之前,用户捞回来的仓会被一次「重跑」静默删掉,而台账重新算过所以
-- 四个数照样自洽,页面看起来完全正常。
--
-- 键用 (dossier_id, week_of) 而不是 scan_id:两者等价(scan_id 就是这两段拼的),
-- 但分开存才能直接问「这个仓在这个档案下被申诉过几周」——那正是决策 8 要的形状:
--   SELECT full_name, COUNT(DISTINCT week_of) AS weeks
--     FROM scan_appeal WHERE dossier_id = ?1 GROUP BY full_name HAVING weeks >= 2;
CREATE TABLE scan_appeal (
  dossier_id TEXT NOT NULL,
  week_of    TEXT NOT NULL,
  full_name  TEXT NOT NULL,
  at         INTEGER NOT NULL,          -- 第一次申诉它的时刻(重复点不覆盖)
  PRIMARY KEY (dossier_id, week_of, full_name)
);
-- 上面那句 GROUP BY 的索引(full_name 在等值/分组位)。
CREATE INDEX ix_appeal_repo ON scan_appeal(dossier_id, full_name);

-- 「他点开了哪一行」(站长 2026-09-01 拍板)。深度报告的点击台账,**一次点击一行**。
--
-- 这个数是两处判据的唯一数据源,而在这之前它无处可查:
--   决策 8:某个 topic 连续 N 周进清单且**点击数为 0** → 建议改档案;
--   风险 2:第二周结束时**点开的深度报告少于 2 份**就停下来复盘形态。
--
-- 为什么 report 表答不了这个问题,两条都是结构性的:
--   ① 去重命中时 report 表**什么都不写**(report.ts 直接 return 旧的那一份),
--      于是第二周点同一个仓等于没点过 —— 而「他又点了一次」恰恰是最强的需求信号;
--   ② report 表没有 week_of / scan_id,只能拿 created_at 去反推是哪一周的清单,
--      而补跑、跨周重拆都会让这个反推出错。
--
-- 记的是**「他点了这一行」这个动作**,不是「报告生成成功了」:配额拒了、
-- GitHub 不通、正在跑另一单,这些都不改变「他想看这个」这件事,而这三种失败
-- 恰恰是最该被看见的需求信号(用户想看却没看成)。所以写入点在「确认这个仓
-- 真的在这一周的清单上」之后、任何闸门和网络之前。
--
-- 只增不改:同一个仓同一周点第二次再落一行(主键带 at)。想数「几个仓被点过」
-- 用 COUNT(DISTINCT full_name),想数「点了几下」用 COUNT(*) —— 两个问题都答得了,
-- 而合并成一行只答得了前一个。
--   风险 2 的判据:
--     SELECT COUNT(DISTINCT full_name) FROM candidate_open WHERE scan_id LIKE ?1 || '#%';
CREATE TABLE candidate_open (
  scan_id   TEXT NOT NULL,              -- = weeklyScanId(dossier_id, week_of)
  full_name TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (scan_id, full_name, at)
);

-- 「他有没有去翻上一周」(站长 2026-09-01 拍板,migration 冻结前的最后一轮)。
-- **一次翻阅一行,只增不改。**
--
-- 这是 docs/01 风险 4 的仪器,而那条判据的原话是:「第二个月诚实复盘一次:如果
-- 站长从不去翻上一周的结果,那就该把这个产品退回 skill 形态,这不丢人。」
--
-- 上一轮把「翻上一周」这个动作造出来了(跨周那一屏 + weekly_change),但**没有
-- 任何东西记录他有没有真的去翻**。于是第二个月复盘时能拿出来的证据只有记忆,
-- 而人对自己行为的回忆偏向乐观 —— 而这条判据的全部意义就是在你不想承认的时候
-- 逼你承认。一条只能靠回忆执行的判据,和没有判据是同一件事。
--
-- 性质同上面三张表:**列 0002 能加,历史不能。**第二个月的复盘要数的是「这两个月
-- 里翻过几次」,而历史只能从落库的那一天开始攒;等到复盘那天才想起来加这张表,
-- 那两个月就是空的。
--
-- **它不上页面。**站长明确的意思是这份数据用于第二个月的复盘,不是实时给自己看的
-- 计数器 —— 一个显示在页面上的「你这个月翻了 3 次」会反过来改变行为(为了让数字
-- 好看而去点一下),而判据要量的恰恰是**没人看着时**的真实行为。落库、可查即可,
-- 复盘用的 SQL 写在 docs/03「第二个月复盘」那一节。
CREATE TABLE week_view (
  dossier_id     TEXT NOT NULL,
  -- **翻到的是哪一周**(不是「翻的时候是哪一周」)。判据要的两个问题之一
  -- (「翻到过哪几周」)就是 SELECT DISTINCT 这一列。
  week_of        TEXT NOT NULL,
  -- 哪条端点记的:'changes' = GET /api/scan/changes(跨周结论),
  -- 'scan' = GET /api/scan?weekOf=(那一周的整包清单)。
  --
  -- 为什么要有这一列:跨周那一屏一次翻阅**并发发出两条请求**(App.tsx loadWeek),
  -- 所以一次翻阅落两行。不区分来源的话 `COUNT(*)` 就是真实次数的两倍,而那种错
  -- 在一个只有几十行的表里看不出来 —— 数「翻过几次」必须先挑一条 surface
  -- (docs/03 那节 SQL 挑的是 'changes')。
  --
  -- 两条都记而不是只记一条,是因为它们证明的不是同一件事:'changes' 证明他打开了
  -- 跨周结论,'scan' 证明他把那一周的整包清单也拉下来了(将来门铃邮件直连
  -- `?view=changes` 时,可能只有其中一条被打到)。
  surface        TEXT NOT NULL,
  at             INTEGER NOT NULL,
  -- 这一刻**库里最新的那一周**是哪一周(取自 weekly_scan,不是 weekly_change ——
  -- 一周可能有周扫而没有跨周记录,反过来不可能,所以周扫是那个更全的参照系)。
  -- NULL = 这个档案一次周扫都还没跑过。
  --
  -- 这一列是「翻到本周」和「翻上一周」的分界线,而这两者是**完全不同的信号**:
  -- 只看最新那一周 = 「我收到了这周的清单」,那是 skill 也给得了的东西;
  -- `week_of < latest_week_of` 才是「他回头去翻了旧的那一份」,而那正是这个产品
  -- 相对一个 Claude Code skill 的全部存在理由(docs/01「为什么不做成 skill」)。
  --
  -- 为什么写在行上而不是复盘时现算:「那一刻最新的是哪一周」事后无法可靠还原
  -- —— weekly_scan.created_at 会被重跑覆盖成重跑当天,拿它反推会把一次「翻旧的」
  -- 读成「看最新的」。用日历周(翻阅时刻的 isoWeek)也不行:周一 08:00 UTC 的
  -- cron 跑之前,最新的那一周就是上一个日历周,于是每个周一早上正常查看都会被
  -- 记成「翻上一周」——一个每周准时说谎一次的仪器。
  latest_week_of TEXT,
  -- 0/1:调用方**显式**带了 `?weekOf=` 吗。0 = 进跨周屏时页面默认取最新那一周。
  --
  -- 首次自动加载**照样记一行**(他得点那个入口才到得了这一屏,这个动作是真的
  -- 发生了),但要标出来:判据问的是「他会不会回头翻」,而一次默认加载只证明
  -- 他打开过这一屏。区分开之后两个强度的问题都答得了 —— 「打开过几次」用全部行,
  -- 「主动挑过哪一周」加 explicit = 1。
  explicit       INTEGER NOT NULL,
  -- at 进主键:同一周翻第二次要落第二行(「他又回去看了一次」是比「他看过」
  -- 更强的信号)。合并成一行只答得了「翻到过哪几周」,答不了「翻过几次」。
  PRIMARY KEY (dossier_id, week_of, surface, at)
);
-- 复盘那几句 SQL 的形状:一个档案、一段时间窗、按 at 排。dossier_id 是最左列。
CREATE INDEX ix_week_view_at ON week_view(dossier_id, at);
