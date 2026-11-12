# Sqraft 私有云（sqraft-cloud）

把 [Sqraft](https://github.com/wfdx165/sqraft) 设计稿托管在自己的服务器上：设计师用 Mac 上传客户端发布 `.sqraft`，
开发者在网页上查看，或让 AI 编码助手通过 MCP 直接读取布局、Token 和切图——不用再互传文件。

纯单机部署：一个 Node.js 服务 + 一个 SQLite 数据库 + 一个数据目录，`docker compose up` 即可。以 Apache-2.0 开源。

## 当前进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| 1. 服务端基础 | 账号、会话、令牌、项目权限、分块上传与版本、审计日志 | ✅ 已完成 |
| 2. 只读 MCP + 网页查看 | 按页索引、13 个 MCP 只读工具（含 SVG 图标导出、版本差异）、网页看稿与管理后台 | ✅ 已完成 |
| 3. Mac 上传客户端 | 浏览器登录（OAuth 授权码 + PKCE）、选项目与设计稿上传（Electron） | ✅ 已完成 |
| 4. 部署与试点 | 镜像发布、备份恢复、维护与监控、部署文档、试点计划 | ✅ 已完成（试点待开展） |

## 部署

完整步骤见 **[部署手册](docs/deploy.md)**（HTTPS、升级、备份恢复、监控、安全检查清单、常见问题），
试点安排见 **[试点计划](docs/pilot.md)**。

### Docker Compose（推荐）

```bash
git clone --recurse-submodules <本仓库地址> sqraft-cloud && cd sqraft-cloud
cp .env.example .env          # 填好管理员密码与域名
docker compose --profile https up -d   # 自带 Caddy，自动申请 HTTPS 证书
```

已有自己的反向代理（Nginx 等）时去掉 `--profile https`，把代理指向 `127.0.0.1:8080`，并保持 `SQRAFT_TRUST_PROXY=1`。
数据全部在 `./data` 目录：SQLite 数据库、设计稿文件仓库、上传临时文件。**备份就是拷贝这个目录**（建议先停服务，或用 `sqlite3 data/sqraft-cloud.db ".backup x.db"`）。

### 从源码构建

需要 Node.js 22.12+ 与 pnpm 10。

```bash
git submodule update --init
pnpm install
pnpm build                    # 产出 apps/server/dist/server.mjs
SQRAFT_ADMIN_USER=admin SQRAFT_ADMIN_PASSWORD='至少8位' SQRAFT_INSECURE_HTTP=1 node apps/server/dist/server.mjs
```

开发时开两个终端：`pnpm dev`（服务端，8080，热重载）与 `pnpm dev:web`（网页，5173，接口转发到 8080），
浏览器打开 http://localhost:5173。`pnpm test` 跑测试；`pnpm typecheck` 做类型检查；`pnpm build` 构建网页与服务端。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SQRAFT_DATA_DIR` | `./data`（镜像里是 `/data`） | 数据目录 |
| `SQRAFT_HOST` / `SQRAFT_PORT` | `0.0.0.0` / `8080` | 监听地址与端口 |
| `SQRAFT_ADMIN_USER` / `SQRAFT_ADMIN_PASSWORD` | 无 | 没有任何管理员时，启动时创建这个管理员 |
| `SQRAFT_PUBLIC_URL` | 无 | 对外访问地址，用于生成链接 |
| `SQRAFT_TRUST_PROXY` | `0` | 在反向代理后面时设为 `1`，识别 HTTPS 与客户端真实 IP |
| `SQRAFT_INSECURE_HTTP` | `0` | **仅限可信内网**：允许纯 HTTP。关闭时非 HTTPS 请求一律拒绝（健康检查除外） |
| `SQRAFT_MAX_UPLOAD_MB` | `2048` | 单个设计稿上限 |
| `SQRAFT_SESSION_DAYS` | `7` | 网页会话有效期 |
| `SQRAFT_TOKEN_MAX_DAYS` | `0`（不限） | 令牌最长有效期；设置后不再允许「不过期」令牌 |
| `SQRAFT_AUDIT_DAYS` | `180` | 审计日志保留天数 |
| `SQRAFT_MCP_RATE` | `60` | 每个令牌每分钟最多的 MCP 工具调用次数 |
| `SQRAFT_UPLOADER_URL` | GitHub 发布页 | 网页「下载上传客户端」指向的地址（可换成内网的安装包地址） |
| `SQRAFT_WEB_DIR` | 自动 | 网页构建产物目录（镜像里是 `/app/web`） |
| `SQRAFT_TRASH_DAYS` | `30` | 回收站保留天数，过期自动彻底删除 |
| `SQRAFT_METRICS_TOKEN` | 无 | 设置后开放 Prometheus `/metrics`（Bearer 令牌访问） |
| `SQRAFT_LOG_LEVEL` | `info` | 日志级别（JSON 格式输出到标准输出，凭据已脱敏） |

## 运维命令

```bash
node server.mjs backup [--out <file>]    # 在线备份为 .tar.gz（默认 <数据目录>/backups/）
node server.mjs restore <file> [--force] # 恢复（需先停服务；--force 时原目录改名保留）
node server.mjs gc                       # 立即维护：清理回收站、回收孤儿文件与临时文件
```

Docker 里：`docker compose exec -u node sqraft-cloud node server.mjs backup`。服务每天自动执行一次维护；
网页「系统」页有概览（用户、设计稿、存储、近 7 天上传与 MCP 调用量）、回收站（恢复 / 彻底删除）与手动维护。

## 网页

浏览器打开服务地址即可（界面名为「云设计」，左侧导航：项目、最近浏览、人员管理、MCP 令牌、个人设置；
管理员另有审计日志与系统维护）。顶栏可全局搜索项目、设计稿和成员，铃铛里是站内通知。

- **项目**：卡片列表，可按「全部 / 我创建的」筛选、搜索、按更新时间或名称排序；管理员和编辑者可新建项目。
  项目页列出设计稿（状态、创建者、版本、评论数），可按状态筛选；管理员可在「成员权限」里给某个人单独设权限、归档项目。
- **设计稿状态**：草稿 / 评审中 / 已发布，编辑者在设计稿页切换；新建的设计稿默认是草稿。
- **评论与通知**：能看到设计稿的人都能评论（记下当时的版本与页面），输入 `@` 提到成员；
  被 @、自己创建或参与过的设计稿有新评论、被加入团队或项目时收到站内通知。
- **人员管理**：管理员直接建账号（生成初始密码，对方首次登录必须修改）、改角色、重置密码、移除（停用账号，可恢复）。

- **看稿**：项目 → 设计稿。左侧按分组列出画板（一个 Sketch 页面一组，如 v4.3.2；可搜索、只看本版改动），中间两种视图：
  - **总览**：全部画板按组排开显示缩略图，滚轮平移、⌘/Ctrl + 滚轮或捏合缩放；单击选中，双击进入；双击左侧分组定位到该组；
  - **单页**：只看一个画板，← → 翻到上一个 / 下一个，Esc 回总览；按 `?` 查看全部快捷键。右侧面板：
    - **标注**：单击选中图层（最深一层，面包屑可选上级；Enter 进子图层、⇧Enter 回父图层、Tab 切同级）。
      - 画布：选中框带四角手柄、尺寸标签、组件名徽标；鼠标移到另一个图层显示两者间距（含对齐偏差），移回选中图层显示到父容器的距离，
        移到画板外显示到画板四边的距离；按住 ⌥ 改为相对画板宽高的百分比。⌘ + / ⌘ − / ⌘ 0 缩放，⇧1 适应画布，⇧2 缩放到选中。
      - 面板分区可折叠：位置与尺寸（相对父级或画板；尺寸模式 固定 / 适应内容 / 填充容器；最小最大值；绝对定位；叠加父级后的实际不透明度；
        裁剪与蒙版）、所属组件（属性值、覆盖数）、图片、填充、描边、文字（预览、字体、字重、字号、行高倍数、字距、段距、对齐、截断等）、
        效果、自动布局，以及带语法高亮的 CSS（每个分区可单独复制）。
      - 顶部 ⚙ 选平台与单位：Web（px / rem）、iOS（pt）、Android（dp / sp）、小程序（rpx）；设计稿倍率自动按画板宽判断，也可指定
        @1x / @2x / @3x 或按目标宽度换算；精度 0–2 位小数。颜色格式 HEX / HEX8 / ARGB / RGBA / HSLA / UIColor，点色块循环切换。
      - 绑定了 Token 的值下方显示 Token 名；没绑定但与某个颜色 Token 相同的提示「≈ Token（未绑定）」。点任意值复制。
        选中的图层记在地址栏（`&node=`），可以把链接发给别人；
    - **切图**：选中图层（没选时为整个画板）按当前平台的档位导出——iOS @1x / @2x / @3x、Android mdpi … xxxhdpi（分 drawable-* 目录）、
      Web / 小程序 1x / 2x，格式 PNG / JPG / WEBP，多个档位打成 zip；也可导出 SVG。导出范围按实际可见内容计算（蒙版、裁切、
      投影方向都算在内）；有图片没加载出来时报错而不是导出灰色占位；单边超过 8192px 会等比缩小并提示。重名文件按最终路径自动加后缀。
      本画板用到的位图列表：悬停在画布上高亮所有用到处，点击选中并定位，可下载原图或按档位导出，「打包本页位图」一次导出全部。
  画面用 Sqraft 自己的渲染器绘制，效果与桌面端一致。地址栏带版本、画板与视图（`?v=&board=&mode=detail`），链接发给别人能直接打开同一处。
  大稿按页加载、只给看得见的画板画缩略图，不下载整份 `.sqraft`。
  分组来自 sketch2sqraft 写进 `manifest.json` 的 `sections`；旧文件没有分组时按画布上的横带自动分组。
- **版本变更**：每个版本显示相对上一版改了什么（修改 / 新增 / 删除 / 改名 / 挪动了哪些页面，组件与 Token 的变动），
  明细里点页面名直接跳过去；页面列表给本版改动的页面打点，可勾选「只看本版改动的页面」。
- **发布新版本**：只通过 Mac 上传客户端（网页没有上传入口，侧栏可下载客户端）；编辑者在网页上可以回滚到旧版本。
- **MCP 接入**：创建令牌，复制 Claude Code / Cursor / VS Code 的配置。
- **管理后台**（系统管理员）：用户、项目与成员、审计日志（可导出 CSV）、系统概览与回收站。

## 角色与权限

每个成员有一个团队角色，默认对所有项目生效：

| 团队角色 | 能做什么 |
|---|---|
| 管理员 | 管理成员、所有项目与设计稿（含归档、回收站、审计日志） |
| 编辑者 | 新建项目，上传和更新设计稿、改状态、回滚版本，评论 |
| 查看者 | 查看设计稿、评论 |

管理员可以控制每个成员能看哪些项目（人员管理 →「可见项目」，或项目页 →「成员权限」）：

- **可见范围**：「所有项目」按角色访问，之后新建的项目也能看到；「只看分配的项目」只能看到单独分配了的项目，新项目默认看不到（适合外包、临时协作的同事）；
- **单个项目**：可以覆盖成可编辑、只读或「看不到」，优先于可见范围。
从旧版本升级时，原来的普通用户会被设为查看者，并对他原本没被分配的项目设为「看不到」，可见范围保持不变。

## Mac 上传客户端（apps/uploader）

设计师用的桌面客户端（Electron，Apple Silicon）：

1. 填私有云地址（会先请求 `/api/v1/info` 确认是 Sqraft 私有云且版本兼容）；
2. 点「在浏览器中登录」：浏览器打开私有云授权页，登录并点「授权」后跳回客户端（`sqraft-uploader://` 协议）。
   全程是 OAuth 2.0 授权码 + PKCE，客户端不接触密码；换到的是 uploader 用途的令牌，默认 90 天；
3. 拖入或选择 `.sqraft`（`.sketch` 会提示先用 sketch2sqraft 转换），选项目与设计稿（或新建），填版本说明，上传。
   完成后显示相对上一版改了哪些页面，可复制设计稿链接、在浏览器打开。

**增量上传**：客户端先在本地把 `.sqraft` 拆成页面 / 组件 / 切图并算哈希，问服务端缺哪些，只传缺的。
更新一份设计稿时通常只有改过的那几页要传——实测 160 MB 的稿子（882 个页面、553 张切图）改一页后重新上传，
实际只传了约 10 KB，服务端约 0.5 秒生成新版本；时间主要花在本地分析（这份 267 MB 的 doc.json 约 8 秒）。
连接的是不支持增量的老服务端时自动退回整包分块上传。

客户端记住「本地文件 ↔ 云端设计稿」，同一个文件下次自动预选；云端已有别人发布的更新版本时会提醒。
令牌只在主进程里使用，用 Electron safeStorage（macOS 钥匙串保护的密钥）加密保存，渲染层拿不到。退出登录会吊销令牌。

```bash
pnpm dev:uploader     # 开发
pnpm dist:uploader    # 打包 apps/uploader/release/Sqraft 上传-<版本>-arm64.dmg
```

没有 Apple Developer ID 证书时打出的是未签名包：首次打开需在「系统设置 → 隐私与安全性」里点「仍要打开」。

## MCP（给 AI 编码助手）

端点 `POST /mcp`（Streamable HTTP），用 `Authorization: Bearer sqr_…` 鉴权，只提供只读工具（13 个）：

| 工具 | 用途 |
|---|---|
| `list_projects` / `list_designs` | 找到设计稿 |
| `list_versions` | 版本历史，每个版本带相对上一版的变更数量 |
| `diff_versions` | 两个版本之间新增 / 修改 / 删除 / 改名 / 挪动的页面与组件、Token 与切图的增减 |
| `list_pages` | 页面列表（id、名称、所在分组 `section`、尺寸、节点数、`changedIn` 内容最后变化的版本），按分组排列；`section` 只看一组，`changedSince` 只列某版本之后变过的页面 |
| `read_page` | 页面节点树摘要（与 Sqraft 桌面端 `read_document` 同格式），可只读子树、限层数，分页 |
| `inspect_layout` | 世界坐标、自动布局、Token 解析后的间距，分页 |
| `get_tokens` | 设计 Token |
| `list_components` / `read_component` | 主组件与其内部结构 |
| `get_asset` | 位图切图的 10 分钟签名下载链接（不含图片内容本身） |
| `export_svg` | 把任意节点（图标、插画、按钮…含子树）导出为 SVG，返回签名下载链接；图标多为矢量路径、没有位图，用它拿原样的图标 |
| `search_nodes` | 按文字或图层名找节点所在页面 |

为控制上下文体积，`read_page` 默认省略路径锚点与实例覆盖记录（实测这两项占大稿响应的四分之三），
单次响应在 50 KB 左右；需要时传 `includeVectors` / `includeOverrides`。所有调用都记审计日志。

Claude Code 接入示例（网页「MCP 接入」页会生成带你的地址和令牌的版本）：

```bash
claude mcp add --transport http sqraft https://design.example.com/mcp --header "Authorization: Bearer sqr_..."
```

## 接口一览（`/api/v1`）

所有错误返回 `{ "error": { "code", "message" } }`。网页会话的写请求需带 `X-CSRF-Token`（登录或 `GET /me` 时返回）；
令牌用 `Authorization: Bearer sqr_…`。没有权限看到的资源一律返回 404。

| 方法与路径 | 说明 | 权限 |
|---|---|---|
| `GET /info` | 服务名、版本、API 版本、支持的 `.sqraft` 格式版本 | 公开 |
| `POST /auth/login`、`POST /auth/logout` | 登录（连续 5 次错误锁定 15 分钟）/ 登出 | 公开 |
| `GET /me`、`PATCH /me`、`POST /me/password` | 当前用户；改姓名 / 邮箱；改密码（首次登录必须先改） | 登录 |
| `GET /team/members`、`POST /team/members`、`PATCH /team/members/:id`、`DELETE /team/members/:id`、`POST …/restore` | 成员列表；建账号（返回初始密码）、改角色 / 资料 / 可见范围（`projectScope`: `all` / `assigned`）/ 重置密码、移除与恢复 | 登录 / 管理员 |
| `GET /team/members/:id/projects` | 某个成员在每个项目里的覆盖与实际权限 | 管理员 |
| `GET /me/recent`、`GET /search?q=`、`GET /client` | 最近浏览；全局搜索（项目、设计稿、成员）；上传客户端下载地址 | 登录 |
| `GET/POST /designs/:id/comments`、`DELETE /comments/:id` | 评论（`@用户名` 通知被提到的人）；作者或管理员删除 | 查看者 |
| `GET /notifications`、`POST /notifications/read` | 站内通知；标记已读（不传 ids 即全部） | 网页会话 |
| `GET/POST /tokens`、`DELETE /tokens/:id` | 令牌：用途 `mcp`（只读）或 `uploader`（可上传），可限定项目，明文只返回一次 | 网页会话 |
| `GET /projects`、`GET /projects/:id`、`GET /projects/:id/designs` | 自己能看到的项目（简介、创建者、设计稿数、更新时间、我的角色）与设计稿 | 登录 |
| `POST /projects`、`PATCH /projects/:id` | 新建项目；改名称与描述 | 团队编辑者 / 项目编辑者 |
| `GET /projects/:id/access` | 每个成员在项目里的团队角色、覆盖与实际权限 | 管理员 |
| `POST /projects/:id/designs` | 新建设计稿（默认草稿） | 编辑者 |
| `GET/PATCH/DELETE /designs/:id` | 查看 / 改名、改状态（draft / review / published）/ 删除（进回收站） | 查看者 / 编辑者 |
| `GET /designs/:id/versions`、`POST /designs/:id/rollback` | 版本历史（带变更数量）；回滚当前版本 | 查看者 / 编辑者 |
| `GET /designs/:id/versions/:v/changes` | 这个版本相对上一版的页面级变更明细 | 查看者 |
| `POST /designs/:id/uploads` → `PUT /uploads/:id` → `POST /uploads/:id/complete` | 整包分块、可续传上传（头 `Upload-Offset`，每块 ≤ 64 MB） | 编辑者 |
| `POST /designs/:id/blobs/check` → `PUT /designs/:id/blobs/:hash` → `POST /designs/:id/commits` | 增量上传：问缺哪些、只传缺的、按清单生成版本 | 编辑者 |
| `/admin/users`、`/admin/projects`、`PUT/DELETE /admin/projects/:id/members/:userId` | 用户、项目（归档）、项目权限覆盖（`editor` / `viewer` / `none`） | 系统管理员 |
| `GET /admin/audit?user=&action=&from=&to=&format=csv` | 审计日志查询与 CSV 导出 | 系统管理员 |
| `GET /designs/:id/versions/:v/pages`、`…/pages/:pageId` | 页面列表（含分组 `sections`，按组排列）；单页节点（`:v` 为版本号或 `current`） | 查看者 |
| `GET /designs/:id/versions/:v/parts/:pageId` | 单页节点的原始数据（不含 Token），直接发存储里的 gzip，长缓存 + ETag；总览缩略图用 | 查看者 |
| `GET /designs/:id/versions/:v/components`、`…/tokens`、`…/assets/:assetId` | 组件、Token、切图 | 查看者 |
| `GET /oauth/authorize`（网页）→ `POST /oauth/token` | 上传客户端浏览器登录：授权码 + PKCE（S256），授权码 60 秒、只能用一次 | 公开 / 网页会话 |
| `POST /api/v1/oauth/revoke` | 令牌吊销自己（客户端退出登录） | 令牌 |

### 上传流程

```bash
# 1. 开始：声明文件大小与版本说明
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"size": 433331003, "note": "首页改版"}' $HOST/api/v1/designs/$DESIGN/uploads
# 2. 逐块上传（建议 8 MB 一块）；偏移对不上时返回 409 与服务端已收字节数，按它续传
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' \
     -H "Upload-Offset: 0" --data-binary @chunk0 $HOST/api/v1/uploads/$UPLOAD
# 3. 提交：校验 .sqraft、收录、生成新版本；与当前版本内容相同则不新建版本（duplicate: true）
curl -X POST -H "Authorization: Bearer $TOKEN" $HOST/api/v1/uploads/$UPLOAD/complete
```

上传的 `.sqraft` 会做这些检查：zip 条目白名单（拒绝路径穿越与未知文件）、单条目与总大小上限、压缩比上限、
`doc.json` 结构与节点数上限、格式版本不高于服务端支持的版本。切图、页面都按内容哈希只存一份，多个版本共用。

### 增量上传

设计稿按「部件」拆分：每个顶层页面或主组件连同整棵子树是一个部件，序列化为**规范 JSON**
（对象键按字典序、无空白，形如 `{"nodes":{…},"rootIds":["<id>"]}`），哈希是这段文本（未压缩）的 SHA-256。
切图的哈希是文件字节的 SHA-256。拆分规则在 `packages/shared`，服务端与客户端共用同一份代码。

```bash
# 1. 问服务端缺哪些（部件与切图的哈希放一起）
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"hashes": ["<部件哈希>", "<切图哈希>"]}' $HOST/api/v1/designs/$DESIGN/blobs/check      # → {"missing": [...]}
# 2. 只传缺的：部件 gzip 压缩后传（kind=part），切图传原始字节（kind=asset）；哈希对不上拒收
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' \
     --data-binary @part.json.gz "$HOST/api/v1/designs/$DESIGN/blobs/$HASH?kind=part"
# 3. 按清单生成版本（响应与整包上传的 complete 相同）；还缺文件时返回 409 missing_blobs 与缺的哈希
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' $HOST/api/v1/designs/$DESIGN/commits -d '{
  "note": "改了个人中心",
  "manifest": {
    "formatVersion": 7, "tokens": {…},
    "parts":  [{"rootId": "<页面或组件 id>", "hash": "<部件哈希>"}],
    "assets": [{"name": "assets/<id>.png", "hash": "<切图哈希>", "size": 12345}],
    "sections": [{"name": "v4.3.2", "pageIds": ["<页面 id>"]}]
  }
}'
```

版本仍是整份设计稿的完整快照（页面、组件、Token 始终一致），增量只省传输。每个版本生成时会和当时的当前版本比较，
记下页面级变更；比较按「内容哈希」进行，不计页面根节点的名称与画布位置，所以只改名、只挪位置单独列为改名 / 挪动。
每个页面还记着「内容最后变化的版本」（`changedIn`）。

## 代码结构

```
apps/web/               网页（Vue 3 + Vite），画布复用 @sqraft/render
apps/uploader/          Mac 上传客户端（Electron + Vue 3）
packages/shared/        服务端与客户端共用的拆分规则（部件、规范 JSON、内容哈希）
apps/server/            Node.js 服务（Fastify + better-sqlite3）
  src/indexer.ts        按页索引与搜索索引（整包与增量两种来源，没变的页面沿用基准版本）
  src/changes.ts        版本之间的页面级差异
  src/versions.ts       生成新版本（判重、标记变更）
  src/routes/commits.ts 增量上传接口
  src/routes/members.ts 成员、个人资料、最近浏览、全局搜索
  src/routes/comments.ts 评论与站内通知
  src/reader.ts         设计稿读取（版本解析、按页加载、LRU 缓存、切图签名）
  src/mcp/              MCP 端点与只读工具（复用 @sqraft/ai-tools）
  src/app.ts            组装应用：凭据解析、CSRF、HTTPS 强制、安全响应头、错误格式
  src/auth.ts           会话 / 令牌 / 项目权限
  src/sqraft-file.ts    .sqraft 校验与收录
  src/storage.ts        内容寻址文件仓库
  src/routes/           各组接口
  test/                 vitest 接口测试
vendor/sqraft/          sqraft 仓库（git submodule，锁定发布 tag），复用 @sqraft/core 等
deploy/Caddyfile        自动 HTTPS 的反向代理配置
```

升级依赖的 sqraft 版本：`cd vendor/sqraft && git fetch --tags && git checkout vX.Y.Z`，回到仓库根目录提交子模块指针。

## 已知限制（后续里程碑处理）

- 原始 `doc.json` 未压缩存储（按页拆分的索引是 gzip 的）；大稿收录时整份解析，内存峰值约为 doc.json 大小的 6 倍。
- 网页画布暂不支持点选节点查看属性、测距（W4、W6）；MCP 暂无 PNG 截图。
- 增量上传的本地分析在 Electron 主进程里同步进行，几百 MB 的 doc.json 要几秒，期间不能取消。
- 变更判断以节点 id 为准：sketch2sqraft 给重名节点加的序号（`~1`、`~2`）按整份文档的顺序分配，
  在前面的页面里增删这类节点，后面一些页面的 id 可能跟着变，被算作修改（多传一些、多报一些，不会漏报）。
- 只支持「整份文件」作为一个版本：还不能只勾选部分页面发布（多人分别改不同页面时需要合并，后续再做）。
- SVG 导出不支持内阴影与背景模糊（会在结果里提示）；文字换行按估算宽度，字形以查看端字体为准。
- 从 Sketch 转换来的稿子里，用布尔运算（减去、相交）做的图标会被 sketch2sqraft 近似成并集，导出后是实心块——需在转换工具里改进。

## 许可证

[Apache-2.0](LICENSE)
