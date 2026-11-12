# Sqraft 私有云（sqraft-cloud）

把 [Sqraft](https://github.com/wfdx165/sqraft) 设计稿托管在自己的服务器上：设计师用 Mac 上传客户端发布 `.sqraft`，
开发者在网页上查看，或让 AI 编码助手通过 MCP 直接读取布局、Token 和切图——不用再互传文件。

纯单机部署：一个 Node.js 服务 + 一个 SQLite 数据库 + 一个数据目录，`docker compose up` 即可。以 Apache-2.0 开源。

## 当前进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| 1. 服务端基础 | 账号、会话、令牌、项目权限、分块上传与版本、审计日志 | ✅ 已完成 |
| 2. 只读 MCP + 网页查看 | 按页索引、11 个 MCP 只读工具、网页看稿与管理后台 | ✅ 已完成 |
| 3. Mac 上传客户端 | 浏览器登录（OAuth 授权码 + PKCE）、选项目与设计稿上传（Electron） | ✅ 已完成 |
| 4. 部署与试点 | 镜像发布、备份恢复、部署文档 | 部分完成（Dockerfile / compose） |

## 部署

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
| `SQRAFT_WEB_DIR` | 自动 | 网页构建产物目录（镜像里是 `/app/web`） |
| `SQRAFT_LOG_LEVEL` | `info` | 日志级别（JSON 格式输出到标准输出，凭据已脱敏） |

## 网页

浏览器打开服务地址即可：

- **看稿**：项目 → 设计稿 → 左侧页面列表（可搜索），中间是只读画布（用 Sqraft 自己的渲染器，效果与桌面端一致），
  顶部切换版本；滚轮平移、⌘/Ctrl + 滚轮或触控板捏合缩放。地址栏带版本与页面，链接发给别人能直接打开同一页。
  大稿按页加载，不下载整份 `.sqraft`。
- **上传**：编辑者可在设计稿页面直接上传新版本（分块、可取消），也可回滚到旧版本。
- **MCP 接入**：创建令牌，复制 Claude Code / Cursor / VS Code 的配置。
- **管理后台**（系统管理员）：用户、项目与成员、审计日志（可导出 CSV）。

## Mac 上传客户端（apps/uploader）

设计师用的桌面客户端（Electron，Apple Silicon）：

1. 填私有云地址（会先请求 `/api/v1/info` 确认是 Sqraft 私有云且版本兼容）；
2. 点「在浏览器中登录」：浏览器打开私有云授权页，登录并点「授权」后跳回客户端（`sqraft-uploader://` 协议）。
   全程是 OAuth 2.0 授权码 + PKCE，客户端不接触密码；换到的是 uploader 用途的令牌，默认 90 天；
3. 拖入或选择 `.sqraft`（`.sketch` 会提示先用 sketch2sqraft 转换），选项目与设计稿（或新建），填版本说明，上传。
   分块上传、可取消；完成后可复制设计稿链接、在浏览器打开。

客户端记住「本地文件 ↔ 云端设计稿」，同一个文件下次自动预选；云端已有别人发布的更新版本时会提醒。
令牌只在主进程里使用，用 Electron safeStorage（macOS 钥匙串保护的密钥）加密保存，渲染层拿不到。退出登录会吊销令牌。

```bash
pnpm dev:uploader     # 开发
pnpm dist:uploader    # 打包 apps/uploader/release/Sqraft 上传-<版本>-arm64.dmg
```

没有 Apple Developer ID 证书时打出的是未签名包：首次打开需在「系统设置 → 隐私与安全性」里点「仍要打开」。

## MCP（给 AI 编码助手）

端点 `POST /mcp`（Streamable HTTP），用 `Authorization: Bearer sqr_…` 鉴权，只提供只读工具：

| 工具 | 用途 |
|---|---|
| `list_projects` / `list_designs` / `list_versions` | 找到设计稿与版本 |
| `list_pages` | 页面列表（id、名称、尺寸、节点数） |
| `read_page` | 页面节点树摘要（与 Sqraft 桌面端 `read_document` 同格式），可只读子树、限层数，分页 |
| `inspect_layout` | 世界坐标、自动布局、Token 解析后的间距，分页 |
| `get_tokens` | 设计 Token |
| `list_components` / `read_component` | 主组件与其内部结构 |
| `get_asset` | 切图的 10 分钟签名下载链接（不含图片内容本身） |
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
| `GET /me`、`POST /me/password` | 当前用户；改密码（首次登录必须先改） | 登录 |
| `GET/POST /tokens`、`DELETE /tokens/:id` | 令牌：用途 `mcp`（只读）或 `uploader`（可上传），可限定项目，明文只返回一次 | 网页会话 |
| `GET /projects`、`GET /projects/:id/designs` | 自己有权限的项目与设计稿 | 登录 |
| `POST /projects/:id/designs` | 新建设计稿 | 编辑者 |
| `GET/PATCH/DELETE /designs/:id` | 查看 / 改名 / 删除（进回收站） | 查看者 / 编辑者 |
| `GET /designs/:id/versions`、`POST /designs/:id/rollback` | 版本历史；回滚当前版本 | 查看者 / 编辑者 |
| `POST /designs/:id/uploads` → `PUT /uploads/:id` → `POST /uploads/:id/complete` | 分块、可续传上传（头 `Upload-Offset`，每块 ≤ 64 MB） | 编辑者 |
| `/admin/users`、`/admin/projects`、`/admin/projects/:id/members/:userId` | 用户、项目、成员管理 | 系统管理员 |
| `GET /admin/audit?user=&action=&from=&to=&format=csv` | 审计日志查询与 CSV 导出 | 系统管理员 |
| `GET /designs/:id/versions/:v/pages`、`…/pages/:pageId` | 页面列表；单页节点（`:v` 为版本号或 `current`） | 查看者 |
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
`doc.json` 结构与节点数上限、格式版本不高于服务端支持的版本。切图按内容哈希只存一份，多个版本共用。

## 代码结构

```
apps/web/               网页（Vue 3 + Vite），画布复用 @sqraft/render
apps/uploader/          Mac 上传客户端（Electron + Vue 3）
apps/server/            Node.js 服务（Fastify + better-sqlite3）
  src/indexer.ts        上传时按页拆分 doc.json、建搜索索引
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
- 网页画布暂不支持点选节点查看属性、测距（W4、W6）；MCP 暂无 `diff_versions` 与服务端截图。
- 上传校验失败时已写入仓库的文件不会立即清理（不影响正确性，后续加垃圾回收）。
- 回收站 30 天自动清理、管理员彻底删除尚未实现。

## 许可证

[Apache-2.0](LICENSE)
