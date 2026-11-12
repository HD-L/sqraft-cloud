#!/bin/sh
# 容器入口：以 root 启动时先把数据目录交给 node 用户（宿主机 bind mount 出来的目录常是 root 所有），
# 再用 setpriv 降权运行，服务本身永远不以 root 身份运行。
set -e
DATA="${SQRAFT_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  [ "$(stat -c %u "$DATA")" = "1000" ] || chown node:node "$DATA"
  find "$DATA" -mindepth 1 ! -user node -exec chown node:node {} + 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
