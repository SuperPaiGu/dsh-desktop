# dsh-desktop

给 DeepSeek Harness（DSH）加桌面窗口入口的 **dsh 组合包（bundle）**。

- 安装后，Web UI 命令面板多一条 `/desktop` 命令——在独立桌面窗口里打开 Harness（与浏览器同一界面、同一会话）
- npm/tarball 渠道附带**便携桌面 exe**，一条 `dsh-desktop install` 命令把它装到桌面，之后**双击即用**
- 纯 JavaScript，**无安装期构建步骤**：git 安装不需要任何 `allowBuilds` 授权

> 本页提供两版安装指南：[给人看](#给人看的安装指南) 和 [给 AI Agent 看](#给-ai-agent-看的安装指南)。

---

## 给人看的安装指南

### 前提

| 要求 | 说明 |
|---|---|
| Windows 10/11 | 桌面 exe 与 Edge 应用窗口均为 Windows 形态 |
| Node.js ≥ 22 | DSH 的要求 |
| 可用的 dsh | 源码 checkout（`pnpm dsh`）或 npx 安装版均可 |
| pnpm 在 PATH | `dsh plugin add` 内部调用 pnpm |

### 第一步：安装（三选一）

```sh
# 方式 1：从本仓库直装（最简单，无需下载文件；不带 exe，/desktop 用 Edge 应用窗口）
dsh plugin --profile web add github:SuperPaiGu/dsh-desktop

# 方式 2：从 Releases 下载 .tgz 后本地安装（带桌面 exe）
dsh plugin --profile web add ./dsh-desktop-0.1.0.tgz

# 方式 3：npm（带桌面 exe；包发布到 npm 后可用）
dsh plugin --profile web add dsh-desktop
```

### 第二步：重启 dsh web

组合只在启动时挂载一次：关掉当前服务，重新启动。之后到 **设置 → 插件 → 插件列表** 能看到 `dsh-desktop` 的 desktop 行（active）。

### 第三步：日常使用

**A. Web UI 里开桌面窗口**：命令面板输入 `/desktop`。

**B. 装一个桌面图标（方式 2/3 装的人才需要这一步）**：

```sh
cd %DSH_HOME%\profiles\web
pnpm exec dsh-desktop install
```

桌面出现带图标的 **DSH 桌面版**，双击即用；`%DSH_HOME%` 默认是 `C:\Users\<用户名>\.dsh`。

**C. 终端直接启动**：`pnpm exec dsh-desktop`。

### 卸载

```sh
dsh plugin --profile web remove dsh-desktop
```

再重启一次服务。桌面 exe 是独立单文件，插件卸载后仍可双击使用。

---

## 给 AI Agent 看的安装指南

> 本节是给在用户机器上执行安装任务的 AI Agent 的确定性指令。命令必须原样执行，按顺序完成，每步都给出验收条件。

### 0. 环境检测

依次执行并记录结果：

```sh
node -v          # 必须 ≥ v22
pnpm -v          # 任意版本；若缺失，npm install -g pnpm
dsh --version    # dsh 可用性检测；若命令不存在，提示用户先安装 dsh（npx @deepseek-ai/dsh 或源码 checkout）
```

所有命令可用且 node ≥ 22 才能继续。

### 1. 安装

按可用渠道任选其一，**只执行一次**：

```sh
# GitHub 直装（无需下载；无 exe，/desktop 降级为 Edge 应用窗口）
dsh plugin --profile web add github:SuperPaiGu/dsh-desktop

# 或 tarball（带 exe；先取得 dsh-desktop-0.1.0.tgz 文件）
dsh plugin --profile web add ./dsh-desktop-0.1.0.tgz
```

**验收**：命令退出码 0，输出含 `+ dsh-desktop`。

### 2. 验证组合层

```sh
dsh --profile web --dump-config
```

**验收**：输出中出现 `# == dsh-desktop` 段和 `name: dsh-desktop` 行。

### 3. 重启 dsh web

找到当前 dsh web 进程，SIGINT/SIGTERM 停止，等待退出，再以用户原有方式重新启动（`npx @deepseek-ai/dsh web`、`pnpm dsh web` 或用户的启动脚本）。若服务是桌面 exe 拉起的，关闭 exe 窗口即停止，双击图标即重启。

**验收**：启动日志出现 `[dsh-desktop] /desktop command registered`（无此行说明插件行未激活，检查第 1、2 步）。

### 4. （仅 tarball/npm 渠道）安装桌面 exe

```sh
cd "$DSH_HOME/profiles/web"      # Windows 为 %DSH_HOME%\profiles\web；DSH_HOME 默认 ~/.dsh
pnpm exec dsh-desktop install
```

**验收**：输出 `exe 已复制到: ...` 与 `桌面快捷方式已创建`；目标目录出现 `DSH-Desktop-*.exe`。

### 5. 验收清单（全部满足才算完成）

- [ ] `dsh plugin` 安装退出码 0
- [ ] `--dump-config` 含 dsh-desktop 层
- [ ] 服务重启后日志含 `[dsh-desktop] /desktop command registered`
- [ ] 设置 → 插件 → 插件列表 中 desktop 行为 active
- [ ]（tarball/npm）桌面出现 DSH 桌面版 图标

### 6. 常见错误处理

| 现象 | 处理 |
|---|---|
| `dsh: pnpm failed in profile directory ... different major version of pnpm` | 在 profile 目录执行 `pnpm install --config.confirm-modules-purge=false`，然后重试第 1 步 |
| pnpm 提示 approve-builds / allowBuilds | 本插件无构建脚本，不应出现；若出现说明命中了其他依赖，按其提示把打印的键写进 profile 的 `pnpm-workspace.yaml` 后重试 |
| `/desktop` 后无窗口 | 确认服务在 3080（或配置端口）上运行；确认安装渠道是否带 exe（不带则用 Edge 窗口，需系统装有 Edge） |
| 双击桌面 exe 停在"无法连接 DSH 服务" | exe 找不到 dsh CLI 来拉起服务：设置环境变量 `DSH_BIN` 指向 dsh CLI，或先手动启动 dsh web 再双击（接入模式） |
| 端口被占用 | 修改 `%APPDATA%\dsh-desktop\config.json` 的 `port`，或关闭占用者 |

### 7. 环境变量参考

- `DSH_HOME`：dsh 主目录（默认 `~/.dsh`），profile 位于其下 `profiles/<name>`
- `DSH_BIN`：桌面 exe 拉起服务时使用的 dsh CLI 路径（找不到自动探测时才需要）
- `DSH_DESKTOP_REPO`：桌面 exe 自建服务时使用的 deepseek-harness 检出路径

---

## 从源码构建桌面 exe（可选，给开发者）

```sh
cd desktop
pnpm install        # 首次需联网（electron ~120MB；若 pnpm 拦截其安装脚本，见 desktop/pnpm-workspace.yaml）
pnpm run dist       # 产出 dist/DSH-Desktop-<版本>-x64.exe（离线构建）
```

- 构建使用本机已装 Electron（`electronDist`），不依赖 GitHub 下载
- 自定义图标：把 `build/icon.ico`（16~256 多帧）放进 `desktop/build/` 即自动使用；没有则用 Electron 默认图标
- 打包时**必须关闭正在运行的桌面 exe**（输出文件被锁会导致构建卡在最后一步）
- 若 pnpm 仍拦截 electron 安装脚本，手动执行 `node node_modules/electron/install.js`

## 目录结构

```
dsh-desktop/            组合包根：dsh-plugin 元数据与命令插件
├── package.json        dsh.bundle 声明（组合包 manifest）
├── cordis.patch.yml    插入的插件层：id desktop → dsh-desktop
├── index.js            Host 插件：注册 /desktop 命令（纯 JS，无构建步骤）
├── bin/                dsh-desktop 命令（run / install / help）
└── desktop/            Electron 桌面壳源码与构建（独立 package.json）
    ├── src/            主进程与预加载（探测→接入→自建→跟随退出、断线重试、单实例锁）
    ├── loading.html/js  启动/错误状态页
    ├── config.json     壳配置
    └── dist/           electron-builder 产物（exe 随 npm/tarball 分发，不进 git）
```

## 已知限制

- 仅支持 Windows（桌面 exe 与 Edge 应用窗口均为 Windows 形态；非 Windows 上 `/desktop` 返回友好错误）
- 独立双击 exe 的"自建服务"需要能找到 dsh CLI：按 `deepseek-harness 检出 → DSH_BIN → 安装版 .bin/dsh → PATH dsh` 顺序探测，都找不到时先把 dsh web 跑起来再用接入模式
- 便携 exe 首次启动需解包数秒；桌面 exe 运行期间无法重新打包它自己
