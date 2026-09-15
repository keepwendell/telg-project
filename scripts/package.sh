#!/usr/bin/env bash
# 打包 TELG 工程为可分发的 zip（排除运行期产物与临时文件）
# 产物输出到工程根目录的上一级（会话根目录），zip 顶层为 telg-project/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$ROOT")"

OUT="$PARENT/telg-project.zip"
rm -f "$OUT"
rm -f "$ROOT/telg-project.zip"   # 清理误生成的内层包

cd "$PARENT"
zip -r "$OUT" telg-project \
  -x "telg-project/.git/*" \
  -x "telg-project/*__pycache__*" \
  -x "telg-project/*.pyc" \
  -x "telg-project/backend/telg.db" \
  -x "telg-project/backend/storage/*" \
  -x "telg-project/backend/storage" \
  -x "*.zip" \
  -x "telg-project/.*" \
  -x "telg-project/*/_shots/*"

echo "✔ 打包完成: $OUT"
unzip -l "$OUT" | grep -c "telg-project/" | xargs echo "文件数:"
unzip -l "$OUT" | awk '{print $4}' | grep -oP '(?<=telg-project/)[^/]+/' | sort -u
