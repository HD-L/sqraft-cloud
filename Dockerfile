# syntax=docker/dockerfile:1
# Sqraft 私有云镜像：多阶段构建，运行时只含打包后的服务与生产依赖。
# 构建：docker build -t sqraft-cloud .   （需先 git submodule update --init）

FROM node:22-bookworm-slim AS build
# better-sqlite3 优先下载预编译包；拿不到时回退本地编译，需要这些工具
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
RUN test -f vendor/sqraft/packages/core/package.json || (echo "缺少 vendor/sqraft：请先执行 git submodule update --init" && exit 1)
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @sqraft-cloud/server deploy --prod --legacy /out && cp apps/server/dist/server.mjs /out/server.mjs && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    SQRAFT_DATA_DIR=/data \
    SQRAFT_HOST=0.0.0.0 \
    SQRAFT_PORT=8080
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
