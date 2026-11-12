# 部署手册

面向负责部署和维护 Sqraft 私有云的同事。一台 2 核 4 GB 的 Linux 服务器（或 Mac）+ Docker 就够 200 人以内的团队使用。

## 1. 准备

| 项 | 要求 |
|---|---|
| 服务器 | Linux x86_64 或 arm64，2 核 4 GB 起；磁盘按「设计稿总大小 × 1.5」预留 |
| 软件 | Docker 24+、Docker Compose v2 |
| 域名 | 一个解析到服务器的域名（如 `design.example.com`），用于 HTTPS |
| 端口 | 80、443（使用内置 Caddy 自动 HTTPS 时）；或只开放给你自己的反向代理 |

> 大稿内存提示：上传收录一份 400 MB 级的设计稿时，服务进程峰值内存约 1.7 GB。团队里有这种体量的稿子时，建议 8 GB 内存。

## 2. 首次部署

```bash
mkdir sqraft-cloud && cd sqraft-cloud
curl -O https://raw.githubusercontent.com/HD-L/sqraft-cloud/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/HD-L/sqraft-cloud/main/.env.example
mkdir -p deploy && curl -o deploy/Caddyfile https://raw.githubusercontent.com/HD-L/sqraft-cloud/main/deploy/Caddyfile
cp .env.example .env
vi .env                                  # 至少改 SQRAFT_ADMIN_PASSWORD、SQRAFT_PUBLIC_URL、SQRAFT_DOMAIN
docker compose --profile https up -d     # 拉取镜像并启动服务 + Caddy（自动申请 Let's Encrypt 证书）
docker compose logs -f sqraft-cloud      # 看到 "Server listening" 即启动成功
```

打开 `https://你的域名`，用 `.env` 里的管理员账号登录。之后：

1. 「用户」里给团队成员建账号（会生成一次性初始密码，首次登录必须修改）；
2. 「项目管理」里建项目，把设计师加为编辑者、开发者加为查看者；
3. 把 Mac 上传客户端的 DMG 发给设计师（GitHub Release 页面下载）；
4. 让开发者在「MCP 接入」页创建令牌，按页面上的命令接入 Claude Code / Cursor。

### 已有反向代理（Nginx 等）

不用 `--profile https`，只启动服务：`docker compose up -d`。服务监听 `127.0.0.1:8080`，反向代理配置要点：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64m;      # 上传是 8 MB 一块
    proxy_read_timeout 300s;       # 大稿提交后的校验与建索引可能要几十秒
}
```

`.env` 里保持 `SQRAFT_TRUST_PROXY=1`，服务才能识别 HTTPS 与客户端真实 IP。

### 内网 HTTP（不推荐）

只在可信内网、没有证书时使用：`.env` 里设 `SQRAFT_INSECURE_HTTP=1`、`SQRAFT_BIND=0.0.0.0`。令牌与设计稿会明文传输，客户端会显示风险提示。

## 3. 从源码构建镜像

```bash
git clone --recurse-submodules https://github.com/HD-L/sqraft-cloud.git && cd sqraft-cloud
docker build -t sqraft-cloud:local .
```

在 `.env` 里设 `SQRAFT_IMAGE=sqraft-cloud:local` 即可。无外网环境：在有网的机器上构建后 `docker save` / `docker load` 搬过去。

## 4. 升级

```bash
docker compose exec -u node sqraft-cloud node server.mjs backup   # 先备份
docker compose pull && docker compose up -d                # 换新镜像
```

启动时自动迁移数据库；迁移前会在数据目录里自动留一份 `sqraft-cloud.db.v<旧版本>-<时间>.bak`。

## 5. 备份与恢复

数据全部在 `./data`（容器内 `/data`）：SQLite 数据库 + 内容寻址的文件仓库。
容器以 root 启动时会先把数据目录交给 `node` 用户再降权运行，宿主机目录不需要手动改权限；
在容器里执行维护命令时请带 `-u node`，避免生成 root 所有的文件。

**备份**（服务运行中即可，数据库用在线快照，结果一致）：

```bash
docker compose exec -u node sqraft-cloud node server.mjs backup
# → /data/backups/sqraft-cloud-20261112-090000.tar.gz（宿主机上是 ./data/backups/）
```

建议用 cron 每天备份一次，并把 `./data/backups/` 同步到另一台机器或对象存储；旧备份自行按需清理。

```cron
0 3 * * * cd /srv/sqraft-cloud && docker compose exec -T -u node sqraft-cloud node server.mjs backup >> backup.log 2>&1
```

**恢复**（需先停服务）：

```bash
docker compose stop sqraft-cloud
docker compose run --rm sqraft-cloud node server.mjs restore /data/backups/sqraft-cloud-20261112-090000.tar.gz --force
docker compose start sqraft-cloud
```

`--force` 会把原数据目录改名为 `data.before-restore-<时间>` 保留，确认无误后再手动删除。
备份来自更新版本的服务时会拒绝恢复，请先升级再恢复。

## 6. 日常维护

服务每天自动执行一次维护：

- 回收站里超过 `SQRAFT_TRASH_DAYS`（默认 30）天的设计稿连同版本彻底删除；
- 回收没有任何版本引用的文件（上传失败的残留、彻底删除的设计稿）；
- 清理过期会话、超期审计日志（`SQRAFT_AUDIT_DAYS`，默认 180 天）与临时文件。

也可以在网页「系统」页点「立即执行维护」，或执行 `docker compose exec -u node sqraft-cloud node server.mjs gc`。
「系统」页能看到用户数、设计稿数、存储占用、近 7 天上传与 MCP 调用量，以及回收站（可恢复或立即彻底删除）。

## 7. 监控

| 端点 | 用途 |
|---|---|
| `GET /healthz` | 进程存活（容器 HEALTHCHECK 已使用） |
| `GET /readyz` | 数据库可用 |
| `GET /metrics` | Prometheus 指标；设置 `SQRAFT_METRICS_TOKEN` 后开放，用 `Authorization: Bearer <令牌>` 抓取 |

```yaml
# prometheus.yml
scrape_configs:
  - job_name: sqraft-cloud
    authorization: { credentials: "<SQRAFT_METRICS_TOKEN>" }
    static_configs: [{ targets: ["sqraft-cloud:8080"] }]
```

指标包括用户 / 项目 / 设计稿 / 版本数、存储字节数、HTTP 请求数（按路由与状态码）、MCP 工具调用数、进程内存。
日志是 JSON 格式输出到标准输出（`docker compose logs`），令牌、Cookie 已脱敏。

## 8. 安全检查清单

- [ ] 使用 HTTPS（内置 Caddy 或自己的反向代理），没有开启 `SQRAFT_INSECURE_HTTP`
- [ ] 改掉了 `.env` 里的默认管理员密码，`.env` 文件权限为 600
- [ ] 服务端口只绑定 `127.0.0.1`（`SQRAFT_BIND`），对外只开放 80 / 443
- [ ] 按需设置 `SQRAFT_TOKEN_MAX_DAYS`，限制令牌最长有效期
- [ ] 每日备份并异地保存，至少演练过一次恢复
- [ ] 有人离职时在「用户」里停用账号（立即下线并吊销其全部令牌）
- [ ] 定期在「审计日志」里查看异常登录与 MCP 调用

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 网页提示「需要通过 HTTPS 访问」 | 反向代理没传 `X-Forwarded-Proto`，或没设 `SQRAFT_TRUST_PROXY=1` |
| 上传大文件卡在「正在校验」后失败 | 反向代理超时太短，调大 `proxy_read_timeout`；或服务器内存不足 |
| 客户端「在浏览器中登录」后没跳回 | 浏览器询问是否打开「Sqraft 上传」时选「允许」；检查客户端填的地址与浏览器里的一致 |
| AI 助手报 401 | 令牌过期或被吊销，在「MCP 接入」页重建并更新配置 |
| 磁盘占用比预期大 | 「系统」页执行维护；回收站里的设计稿保留期内仍占空间 |
| 首次启动日志提示「还没有任何管理员」 | `.env` 里没设 `SQRAFT_ADMIN_USER` / `SQRAFT_ADMIN_PASSWORD`，设好后重启 |
