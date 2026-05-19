#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# OpenCode Multiplexer Integration - 安装到 OpenCode 本地插件目录
#
# 用法:
#   ./scripts/install.sh
# =============================================================================

log_info()  { printf "  \033[36m[INFO]\033[0m  %s\n" "$*"; }
log_ok()    { printf "  \033[32m[OK]\033[0m    %s\n" "$*"; }
log_error() { printf "  \033[31m[ERROR]\033[0m %s\n" "$*" 1>&2; exit 1; }

# --- 常量 ---------------------------------------------------------------
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="opencode-multiplexer-integration"
OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGINS_DIR="$OPENCODE_DIR/plugins"

# --- 入口 ---------------------------------------------------------------
echo ""
echo "  OpenCode Multiplexer Integration Installer"
echo ""

log_info "插件目录: $PLUGIN_DIR"
log_info "目标目录: $PLUGINS_DIR"

# === Step 1: 构建插件 ==================================================
echo ""
log_info "[1/3] 构建插件..."

if [ -f "$PLUGIN_DIR/dist/index.js" ]; then
  log_ok "构建产物已存在"
else
  log_info "执行 bun run build ..."
  (cd "$PLUGIN_DIR" && bun install && bun run build) || log_error "构建失败，请手动执行 bun run build"
  log_ok "构建完成"
fi

# === Step 2: 安装到本地插件目录 =========================================
echo ""
log_info "[2/3] 安装到本地插件目录..."

mkdir -p "$PLUGINS_DIR"

# 生成 bridge 文件，让 OpenCode 加载项目中的 dist 产物
# dist/index.js 依赖 zod，已在项目 node_modules 中
# 通过包装函数传入配置，避免依赖 npm 安装后的元组语法传参
BRIDGE_FILE="$PLUGINS_DIR/$PLUGIN_NAME.js"
cat > "$BRIDGE_FILE" <<- EOF
import MultiplexerPlugin from "${PLUGIN_DIR}/dist/index.js";

export default async (ctx) => {
  return MultiplexerPlugin(ctx, {
    multiplexer: {
      type: "auto",
      layout: "main-vertical",
      main_pane_size: 60,
    },
  });
};
EOF

log_ok "已写入 bridge 文件: $BRIDGE_FILE"

# === Step 3: 清理 opencode.jsonc =========================================
echo ""
log_info "[3/3] 清理 opencode.jsonc..."

CONFIG_FILE="$OPENCODE_DIR/opencode.jsonc"

CHANGES=$(node -e "
var fs = require('fs');

function stripComments(raw) {
  var result = '';
  var inString = false;
  var inComment = false;
  for (var i = 0; i < raw.length; i++) {
    var c = raw[i];
    var next = raw[i + 1];

    if (inComment) {
      if (c === '\n') { inComment = false; result += '\n'; }
      continue;
    }

    if (inString) {
      if (c === '\\\\') { result += c + next; i++; continue; }
      if (c === '\"') { inString = false; }
      result += c;
      continue;
    }

    if (c === '/' && next === '/') { inComment = true; i++; continue; }
    if (c === '\"') { inString = true; }
    result += c;
  }
  return result;
}

function parseConfig(path) {
  if (!fs.existsSync(path)) return null;
  var raw = fs.readFileSync(path, 'utf8');
  raw = stripComments(raw);
  raw = raw.replace(/,(\s*[}\]])/g, '\$1');
  try { return JSON.parse(raw); } catch(e) { return null; }
}

function writeConfig(path, config) {
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

var name = '$PLUGIN_NAME';
var changes = [];
var targets = ['$CONFIG_FILE', '$OPENCODE_DIR/opencode.json'];

for (var i = 0; i < targets.length; i++) {
  var config = parseConfig(targets[i]);
  if (!config || !Array.isArray(config.plugin)) continue;

  var before = config.plugin.length;
  config.plugin = config.plugin.filter(function(p) {
    if (typeof p === 'string') return p !== name;
    return !(Array.isArray(p) && p[0] === name);
  });

  if (config.plugin.length !== before) {
    if (config.plugin.length === 0) delete config.plugin;
    writeConfig(targets[i], config);
    changes.push('removed from ' + targets[i].replace('$OPENCODE_DIR', '\$OPENCODE_DIR'));
  }
}

if (changes.length > 0) {
  console.log(changes.join('; '));
} else {
  console.log('no-changes');
}
")

if [ "$CHANGES" = "no-changes" ]; then
  log_ok "无须清理"
else
  log_ok "已清理: $CHANGES"
fi

echo ""
echo "  =========================================="
log_ok "安装完成！"
echo ""
echo "  插件文件: $PLUGINS_DIR/$PLUGIN_NAME.js"
echo "  在 tmux / zellij 会话中重启 OpenCode 即可激活。"
echo "  =========================================="
echo ""
