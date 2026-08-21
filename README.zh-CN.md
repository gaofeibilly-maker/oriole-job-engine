# 黄雀 Oriole · 全国职位引擎

[English](README.md) · [架构](docs/ARCHITECTURE.md) · [来源说明](docs/SOURCES.md) · [验证手册](docs/VERIFY.md)

**黄雀不是把招聘网页胡乱堆在一起的“爬虫”，而是一台会发现、会核验、会留证、需要人工把关的岗位信息源引擎。**

它面向全国公开招聘信息：先找到“谁在发布岗位”，再确认入口是否安全、可信、可持续；只有经过人工批准的来源才能进入采集；岗位按照真实上班地点归到“省级—地级”两级；最终通过 18 个中英双语 MCP 工具提供给支持 MCP 的 LLM 客户端。

黄雀的核心可以独立运行，不依赖某个网页，也不绑定某一家大模型。你可以用命令行操作、分别调度岗位更新和寻源蜘蛛、嵌入 Node.js 服务，或把它作为 MCP Agent 接到支持 MCP 的客户端。“支持 MCP”是必要条件：任意 LLM 并不会自动获得黄雀的远程访问能力，客户端仍须能启动本地进程，或由运营者另行提供受保护的传输层。

## 已经实现什么

| 能力 | 已实现内容 |
| --- | --- |
| 全国范围 | 34 个省级地区、365 个地级或省直辖分类项的确定性目录 |
| 上班地点分类 | 以岗位写明的工作地点为准；保留一岗多地；可按省、市筛选；境外岗位不会被误收为中国岗位 |
| 来源发现 | 由 4 个官方目录和 19 家版本化优先用人单位构成的 5000+ 有界目标库、9 类渠道、百度官方搜索 API、Common Crawl URL 索引和用户提交 URL |
| 稳定采集 | Lever、Greenhouse、Ashby、带持久 offset 轮转且有安全上限的字节/飞书招聘公开接口适配器、公开 JSON、JobPosting JSON-LD、RSS/Atom、Sitemap XML、受保护的 HTML 列表 |
| 招聘源图谱 | 发布主体、信息源、覆盖地区、入口、采集端点、发现渠道、岗位之间都有可追溯关系 |
| 审核机制 | `候选 → 已探测 → 已批准/已驳回`；发现和探测都不会自动批准 |
| 证据与持久化 | 运行记录、HTTP 摘要、内容哈希、来源/岗位追溯；`oriole-state` 保存完整持久状态树，包括 Registry 压缩包/manifest、企业目标库、蜘蛛队列和收据；压缩原始运行证据另作为 GitHub Artifact 保留 30 天 |
| Agent 接口 | 18 个中英双语 MCP 工具，使用 JSON-RPC 2.0 NDJSON；支持现代版 `2026-07-28` 和兼容版 `2025-11-25`、`2025-06-18`、`2025-03-26` 协商 |
| 自动调度 | 北京时间每日 `00:17` 更新岗位；周日 `01:15` 刷新企业目标库；每日 `02:30` 寻源；周日 `03:30` 深扫；周日 `04:47` 恢复审计 |
| 查询覆盖 | 共 833 个有界发现任务，其中 730 个是地级地区轮换任务，其余覆盖全国、省级、ATS、行业、园区和协会 |
| 岗位新鲜度 | 对外托管的当前岗位投影要求来源级证据不超过 14 天；更早的完整证据仍保留在 Registry，但不冒充新鲜岗位 |
| 安全保护 | 只访问 HTTPS、公网 DNS 固定、SSRF 防护、重定向/robots 检查、超时/大小/行数限制、限流、密钥目标域锁定 |

## 黄雀怎样理解“岗位来源”

黄雀把“发现渠道”和“最终岗位来源”分开：

- **百度**是雷达。配置密钥后，只调用百度千帆官方 API，保存请求级证据，不抓百度搜索结果页。
- **Common Crawl**是补漏和历史 URL 证据。它只查询受控的 `site:` 域名模式，用来证明公开 URL 曾存在，不把它当成全文搜索引擎，也不把它当成岗位最终来源。
- **官方用人单位目录**定义有界寻源目标库。4 个权威输入分别是上交所主板、上交所科创板、巨潮资讯深市 A 股信息披露发布者目录和国务院国资委央企名录；另有独立版本化的 19 家人工审核优先目标。当前文件去重后为 5,425 家。巨潮目录明确按“现行及历史发布者”口径，并排除简称明确以“退/退市”结尾的记录；本次生成时国资委在线请求返回 HTTP 502，因此其中 99 家明确标为 `2026-07-11` 版本快照，绝不冒充在线实时数据。
- **企业招聘官网、官方 ATS、政府公共就业页面**才是长期采集目标。它们必须先通过安全探测，再由人批准。
- **用户提交**允许运营者或另一个 Agent 提交公开 URL，但仍然走同一套“探测—审核—采集”门禁。

不配置百度密钥，不会影响 9 个已批准来源的采集，也不会影响内置官方目录的来源发现。每个查询任务都会明确声明自己能由哪些 Provider 执行：普通关键词主动发现只由百度承担，所以未配置百度时会在 `status.discoveryBacklog` 和发现运行统计中明确显示为 `blocked`；Common Crawl 只执行受控的 `site:` 任务。被阻塞的任务绝不会冒充“已完成”。

公开仓库中**没有任何岗位记录**。执行 `npm run init` 会导入 9 个明确审计过的公开来源种子——8 个企业自有招聘板（含字节跳动）和 1 个政府公共就业来源，让全新克隆可以立即拥有可运行的采集目标，同时不会发布过期或私有岗位快照。这不等于“搜索结果自动批准”：种子清单本身就是经过审核的信任决策，此后新发现的来源仍然必须探测和人工批准。

这里的“覆盖”是可量化的缺口报告，不代表已经抓全全国岗位。5000+ 目标只是有边界的寻源分母，不是 5000+ 个已批准岗位源。蜘蛛会优先处理缺口大、等级高的用人单位，并持久保存失败退避和队列进度；它最多把新线索推进到 `candidate` 或 `probed`，每个新来源仍须人工批准。字节跳动的版本化优先根是 `https://jobs.bytedance.com/`，经过审核的社会招聘列表仍是初始化采集入口。

字节/飞书单个来源每次最多读取 50 页、5,000 条上游原始行、24 MB。如果一次不能读到尾部，提交成功后会在 `source.collection.resume` 保存带指纹和 generation 校验的断点；下一段先刷新头部 1 页，再从尾部断点继续，并故意重叠 1 页。岗位和断点在同一个 Registry 事务中原子提交；写入前会同时比较采集器读到的来源 revision 与已保存断点的 generation，任何一个发生冲突都不会写岗位，也不会推进断点。预览、失败或冲突同样不会推进已保存位置。即使续跑到尾部，非零 offset 开始的这一段仍保持 `pagination.complete: false`：会变化的 offset 列表不是跨天快照，不能据此关闭“本次没看到”的岗位。分页与断点进度要看采集运行和 Registry 证据；`npm run coverage` 只衡量来源、渠道和地区状态，不读取这些进度。

对外托管投影另有 14 天新鲜度边界：`confirmed_active` 岗位必须有合格的来源级近期证据；游标分段只会刷新本次真正看到的岗位。超过 14 天不会删除完整 Registry 中的旧证据，但该岗位不会继续在托管投影里冒充“当前新鲜”。

准确边界和内置目录见 [docs/SOURCES.md](docs/SOURCES.md)。

## 五分钟启动

需要 Node.js `22.13+`。黄雀没有第三方运行依赖；初始化、采集已批准来源、使用官方目录发现，以及运行 Common Crawl 的受控 `site:` 任务都不需要密钥。

```bash
git clone https://github.com/gaofeibilly-maker/oriole-job-engine.git
cd oriole-job-engine
npm ci --ignore-scripts
npm test
npm run init
npm run status
npm run coverage
npm run regions -- --province-code 420000
```

`init` 之后，`status` 应显示 9 个已批准来源、0 个随仓库发布的岗位。只有真实联网采集并明确 `--commit` 后，岗位才会进入 Registry。

如果要检查字节跳动当前公开岗位，可执行 `npm run live-source-check`（不需要百度密钥）。它只做预览，校验申请链接必须属于字节官方招聘域名，并输出精简证据，不输出原始响应或完整岗位描述；预览不会写入岗位，也不会推进持久断点。GitHub 上也可手动运行对应 workflow，或给 Pull Request 加 `live-source-audit` 标签触发。

先用内置官方目录发现全国来源：

```bash
node scripts/huangque/cli.mjs discover \
  --providers official_catalog \
  --force

node scripts/huangque/cli.mjs sources
node scripts/huangque/cli.mjs graph
```

发现只会产生候选，不会偷偷开启采集。先探测一个候选，查看证据和当前 Registry 版本，再明确批准：

```bash
node scripts/huangque/cli.mjs probe --source <来源ID>

node scripts/huangque/cli.mjs review \
  --source <来源ID> \
  --decision approve \
  --reviewer <审核人> \
  --reason "已核验为官方公开招聘来源" \
  --revision <当前Registry版本> \
  --confirm

node scripts/huangque/cli.mjs collect --source <来源ID> --commit
node scripts/huangque/cli.mjs jobs --province-code 420000 --city-code 420100
```

默认数据都在本地：

- `.huangque/state.json`：原子写入的完整 Registry；
- `.huangque/artifacts/`：按内容寻址、压缩保存的证据；
- `.huangque/source-spider-state.json`：持久的用人单位队列和退避状态；
- `.huangque/latest-job-update.json` 与 `.huangque/job-updates/`：最新和按日期归档的岗位更新收据；
- `.huangque/latest-audit.json`：最近一次机器可读自审。

这些目录不会提交到代码分支，可通过环境变量移动到持久磁盘。参考 GitHub 部署把 Registry 保存为 `registry.json.gz`，并用 manifest 同时记录压缩文件和明文的 SHA-256；明文 `registry.json` 不会提交。同一棵 `oriole-state` 状态树还保存经过校验的企业目标库、蜘蛛队列和收据。压缩原始运行证据另作为 GitHub Artifact 保留 30 天。代码会在 Registry 压缩包超过 90 MiB（94,371,840 字节）时明确失败，低于 [GitHub 官方说明的单文件 100 MiB 阻断线](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits)；接近这个保护线的部署应迁移到数据库或对象存储，而不是调高上限。

## 第一次创建 `oriole-state`

定时工作流无法检出一个尚不存在的分支。第一次运行 Actions 前，用一次性目录生成干净状态并创建远端分支。下面的命令不修改当前代码分支，而且最后一步故意**不使用强制推送**：如果远端已经有 `oriole-state`，它会失败，不会覆盖现有持久状态。

```bash
ORIOLE_ORIGIN_URL="$(git remote get-url origin)"
ORIOLE_BOOTSTRAP_ROOT="$(mktemp -d)"
mkdir "$ORIOLE_BOOTSTRAP_ROOT/repository"

npm run init-state -- \
  --output "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data"

ls -1 "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data"
test ! -e "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data/registry.json"

git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" init -b oriole-state
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" config user.name "Oriole State Bootstrap"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" config user.email "actions@users.noreply.github.com"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" remote add origin "$ORIOLE_ORIGIN_URL"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" add -- state-data
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" diff --cached --name-only
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" commit -m "state: initialize oriole-state"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" push origin HEAD:refs/heads/oriole-state
```

待提交清单必须精确包含 `employer-universe.json`、`registry.bundle-manifest.json`、`registry.json.gz` 和 `source-spider-state.json`。初始化摘要必须显示 9 个已审核并批准的种子、0 个岗位、0 次运行、0 张收据，而且没有持久化明文 Registry。这只能证明“持久状态已经初始化”，不能证明岗位更新、寻源蜘蛛或恢复演练在线成功。已有分支出现问题时不要重新初始化覆盖它，应恢复并审计现有状态。

## 让支持 MCP 的 LLM 客户端使用黄雀

启动 MCP Agent：

```bash
npm run mcp
```

在兼容 MCP 的客户端中加入：

```json
{
  "mcpServers": {
    "oriole": {
      "command": "node",
      "args": ["/绝对路径/oriole-job-engine/scripts/huangque/mcp-server.mjs"],
      "env": {
        "HUANGQUE_REGISTRY_PATH": "/绝对路径/oriole-data/state.json",
        "HUANGQUE_ARTIFACT_ROOT": "/绝对路径/oriole-data/artifacts"
      }
    }
  }
}
```

18 个工具覆盖：运行流水线、查看运行、状态、来源覆盖缺口、发现来源、提交来源、安全探测、来源查询、岗位查询、地区查询、图谱查询、人工审核、采集、兼容的到期岗位入口、独立寻源蜘蛛、独立岗位更新、自审和托管投影导出。

MCP 的网络工具默认只做一个很小的工作单元（例如 1 家企业或 1 个到期来源），以便落在工具时限内；调用方可以显式调大有界批次，也可以重复调用。业务结果只要是失败或部分完成，就会返回 `isError: true` 与 `completed: false`，不会因为“进程返回了 JSON”就冒充成功。

这是 stdio MCP 服务，不是默认公开在互联网上的远程 API。兼容客户端必须按上面的配置启动本地进程；如果需要远程调用，应由运营者另行部署并保护传输层。仅仅换成任意一个 LLM，不会自动连上黄雀。

`huangque.list_regions` 会给出省级去重岗位总数、省级但城市待定的数量，以及每个二级城市的数量。同一岗位明确写了省内两个城市时，省级总数只计 1 个，而两个城市各计 1 个。

MCP 内的“批准来源”默认关闭。只有运营者主动设置 `HUANGQUE_ALLOW_MCP_REVIEW=1` 才会开放；命令行人工审核不受这个开关影响。

## 可选：接入百度官方 API

把示例配置复制到本地，设置环境变量或 GitHub Actions Secret，绝对不要把密钥提交到代码仓库：

```bash
cp .env.example .env
export HUANGQUE_BAIDU_API_KEY="<你的密钥>"
node scripts/huangque/cli.mjs discover --providers baidu --max-queries 5
```

密钥只允许发往 `qianfan.baidubce.com`；若把端点改到其他主机，黄雀会直接拒绝。默认每天最多 40 次百度请求，可通过 `HUANGQUE_BAIDU_DAILY_BUDGET` 调低。

不配置百度不会让已批准来源停止采集；它只会让普通关键词主动发现任务明确保持阻塞。无需密钥的 Common Crawl 仍可处理查询计划中的受控 `site:` 任务。

官方参考：[百度千帆 AI Search API](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5)。

## 独立调度

参考 GitHub 自动化把“更新岗位”和“寻找来源”分开：

| 北京时间 | UTC cron | 工作 |
| --- | --- | --- |
| 每日 `00:17` | `17 16 * * *` | 只刷新到期的已批准岗位源 |
| 周日 `01:15` | `15 17 * * 6` | 原子重建并校验持久企业目标库 |
| 每日 `02:30` | `30 18 * * *` | 运行有界寻源蜘蛛 |
| 周日 `03:30` | `30 19 * * 6` | 深度扫描来源和地区缺口 |
| 周日 `04:47` | `47 20 * * 6` | 恢复完整 `oriole-state` 文件树、校验清单与 Registry 状态包、运行 Agent status 并持久化恢复凭据 |

本地运行岗位更新：

```bash
npm run daily
```

本地寻源使用 `npm run source-spider`，深扫模式才加 `-- --deep`。岗位脚本会为北京时间日期写完成收据，同一天重跑会自动跳过；确实需要重跑时加 `--force`。GitHub 的任务可能因排队晚于目标时间，因此这些时间只说明“已配置”，不能当作线上已经成功运行的证据。详细说明见 [docs/SCHEDULING.md](docs/SCHEDULING.md)。

## 招聘源图谱不是一张网址表

每条关系都带证据和观察时间：

```text
发布主体 ← published_by — 来源 — covers_region → 地区
                             │
                             ├─ has_entry_point → 公开入口
                             ├─ has_endpoint → 采集端点
                             ├─ discovered_via → Provider / 查询 / 运行证据
                             └─ lists_job → 标准化岗位
```

发布主体和地区关系以最新的“已批准来源权威证据”为准；当审计过的来源身份发生变化时，过时的 `published_by` 和 `covers_region` 关系会被清理，不会继续留在图谱中误导使用者。

这里说“图谱完善”，是指：进入 Registry 的来源都有其证据能支持的关系，所有关系可追溯、可更新、可审计。它不等于内置的有限目录已经收录全中国每一家企业和每一个岗位；黄雀的价值正是不断扩张并重新核验这张图。

## 你怎样验证

```bash
npm run verify
npm run audit
```

自动测试会检查：5000+ 有界目标库约束、34 个省级和 365 个二级地区、833 个查询任务、上班地点、一岗多地、Provider、大型列表分段轮转、条件请求、断点原子性与并发、图谱证据、Registry 保留策略、状态初始化/恢复、官方 SDK 的 MCP 互操作、SSRF、robots、来源边界和岗位身份。

以下三种结论必须分开说：

1. **实现完成（`implementationComplete`）**：代码、工作流接线、schema 和安全约束已经存在。本地测试通过与 `stateIntegrityPassed` 是辅助检查，都不是线上证据。
2. **当前在线可用（`operationalNow`）**：当前持久状态里有真实可追溯岗位、图谱和队列活动，并且 Provider、GitHub 岗位更新/寻源、完整状态恢复都有符合时限的真实成功证据。只配置 cron、只初始化分支、fixture 或本地运行都不能满足它。
3. **跨日成熟度（`maturityObserved`）**：GitHub 岗位更新成功收据和带在线证据的蜘蛛成功收据，都至少覆盖两个不同的北京时间自然日。它只衡量重复运行，不能单独证明当前所有 `operationalNow` 时效检查仍然通过。

v2.0.0 文档描述的是已经实现的行为，**不声明你的 GitHub 工作流已经真实成功运行**。完整线上检查尚未通过时，应写“实现/配置完成，线上运行验证待完成”；两组日期尚未各覆盖两天时，还要单独写“跨日成熟度待观察”。只有实现、状态完整性、当前在线运行和成熟度全部通过，`fullyOperational` 才为 `true`。

一步一步的验收方法见 [docs/VERIFY.md](docs/VERIFY.md)。

## 明确不做的范围

黄雀只处理公开、无需登录的网页来源，明确排除微信群、图片 OCR、邮件、登录/验证码页面等私域渠道。它不会自动投简历，也不参与用工决策。公开可访问不代表可以忽略网站条款、robots、数据库权利、个人信息保护或适用法律，部署者仍需逐个来源判断合规性。

## 目录

```text
data/huangque/              已核验种子、用人单位目标库、查询/渠道计划、公开目录
scripts/huangque/           CLI、独立岗位更新/寻源蜘蛛、MCP Agent、确定性核心
tests/                      Node 自动测试
docs/                       架构、来源、调度、验证说明
.github/workflows/          CI、企业目标库刷新、岗位/寻源独立调度、完整状态恢复审计
```

项目使用 [Apache-2.0](LICENSE) 开源协议。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 的方式报告。
