# dsh-desktop

给 DeepSeek Harness（DSH）加一个**桌面窗口**。装好之后桌面上会有一个「DSH 桌面版」图标，
双击就能用 DSH——不用开浏览器，不用记命令。

> 本页有两版说明：[给人看](#怎么安装给人看)（照着做就行）和 [给 AI Agent 看](#怎么安装给-ai-agent-看)（如果让 AI 帮你装）。

---

## 更新记录

### v0.1.9

- **修复：遗留服务仍然认不出来（这是「关不干净」的真正根因）。** 0.1.8 的判定里有一条「记录的启动进程必须仍然存活」，但 `cmd /c <dsh.cmd>` 这个包装器**可能在 node 服务起来后就退出**了 —— 于是判定失败、记账被当成陈旧记录清掉、退回「附加」、拿不到 token 报错。
  现在**不再依赖包装器是否存活**：占端口的进程只要是「我们记录的监听进程」，**或**「一个 dsh web 服务、且启动时间不晚于我们记账的时刻」，就判定为自己人；杀之前还会**核对命令行**（必须同时出现 `dsh` 与 `web`）才动手。
- **退出路径加了兜底**：即使包装器已退出、进程句柄为空，关窗时也**按端口找到并结束本次启动的服务**，从源头减少残留。
- 回归测试 19 项（覆盖遗留收回的两种判定路径、就绪时补记监听 PID、退出兜底）。

### v0.1.8

- **修复：记账记的监听 PID 一直是 `null`，导致「收回遗留服务」从未生效。** 记账发生在 `spawn()` 之后**立刻**，那一刻服务还没绑定端口，`findListenerPid()` 自然是空 —— 而收回逻辑要求「账上的监听 PID == 当前监听 PID」，空值永不匹配。
  现在服务**就绪后补记真实的监听 PID**；对旧格式（监听 PID 为空）的记录另加启动时间兜底。

### v0.1.7

- **修复：关掉桌面端后 3080 不释放，重开时报「已在 3080 找到 dsh 服务，但它要求启动 token，而所有已知日志里都没有」。**
  窗口关闭并不保证退出钩子一定执行（被结束进程、崩溃、注销都会跳过），而桌面端拉起的 `dsh web` 隔着 `cmd /c` 包装且是 detached 的 —— 于是它会活下来，带着一个只存在于某次日志里的启动 token。下次启动去「附加」它必然失败，只能手动杀端口。

  现在桌面端**给自己拉起的服务记账**（`<userData>\spawned-servers.json`）。下次启动时若发现「账上那个进程仍占着该端口」，就判定为自己上次的遗留并**先停掉、再重新拉起**。判定用**身份**而不是「是否还活着」：只有账上记录的监听进程、且此刻仍占着该端口才算数 —— **手工启动的服务没有账目，永远不会被误杀**。
- 回归测试 18 项（新增 2 项覆盖遗留收回：必须在附加探测**之前**执行、记账在启动时写入并在正常停止时清除）。

### v0.1.6

- **修复：接入外部主服务时的 401 白页**。新增 `mainServiceLog` 配置（默认 `<userData>\logs\dsh-main.log`），`knownToken()` 一并读取；token 候选改为按日志倒序全部尝试（陈旧行不再遮蔽有效行），并用「303 = 有效 / 401 = 无效」校验（`redirect: 'manual'` 停在第 1 跳）。
- 拿不到 token 时**明确报错**并给出两条出路，不再静默白页。

### v0.1.5

- **新增 `launcher` 配置项，决定桌面窗口自己的服务跑哪个 CLI**：

  | 值 | 行为 |
  |---|---|
  | `auto`（默认） | 有 `deepseek-harness` 检出就用检出，否则用已安装的 CLI（历史行为） |
  | `installed` | **只用已安装的 CLI**，忽略任何检出 |
  | `checkout` | 只用检出，找不到就报错 |

  ⚠️ 默认的 `auto` 意味着：**只要检出存在且能跑，桌面窗口就跑检出，而不是 npm 全局包**。以前检出常年是同一个版本（`dsh-v0.1.1-rc.2`），跟 npm 版号一致所以看不出来；一旦升级检出，桌面窗口就跟着静默换版本。想让窗口固定在 npm 版就设 `"launcher": "installed"`。
- **辅助端精简回一个**：只保留从**已安装 CLI** 启动的辅助端（默认 `3081`）。原先的「源码辅助端」已移除——要跑源码版本请自己用 `pnpm` 启动。相应配置项 `auxSourcePort` / `auxSourceHome` / `auxSourceRepo` 一并删除。
- 启动器选择逻辑抽到 `desktop/src/launcher.js` 并可单元测试：覆盖 `auto`/`installed`/`checkout` 三种偏好、检出存在但不可跑时的回退、以及无检出且无 CLI 的情形。

### v0.1.4

- **修复：npm 辅助端因为找不到 CLI 而启动不了**。Windows 上 `spawnSync('dsh')` 不会按 `PATHEXT` 解析扩展名，而 npm 装出来的是 `dsh.cmd`（外加一个给 Git Bash 用的**无扩展名** `dsh` shell 脚本），所以旧探测必然 ENOENT —— 终端里 `dsh` 能用，桌面端却一直报「未找到已安装的 dsh CLI」。现在改为自己按 `PATH` + `PATHEXT` 解析，且**优先 `.cmd`**（无扩展名那个 shell 脚本 `cmd.exe` 根本跑不了）。
- **修复：辅助端「打开」按钮报 `dsh web authentication required`**。dsh ≥ 0.1.5 的 web 服务用**每次启动生成的一次性 token** 做浏览器鉴权：裸根地址一律 401，只有它启动时打印的 `/?token=...` 才能换取 cookie。该 token 只存在于这个进程的 stdout，而桌面端本来就把 stdout 重定向进了辅助端日志 —— 所以「打开」现在会**从日志里读回带 token 的 URL**，读不到时才回退到裸根地址。
- 面板状态行新增实例日志路径，便于排查。

### v0.1.3

- **辅助端从 1 个变成 2 个**：桌面窗口右下角的面板里现在有两块独立控制区，各自有启动 / 打开 / 停止：

  | 实例 | 默认端口 | 启动方式 | 用途 |
  |---|---|---|---|
  | **npm 辅助端** | `3081` | 已安装的 dsh CLI（npm 全局） | 日常开发插件。**重打包桌面端、升级 dsh 源码都不影响它**，随时有一个能用的 dsh |
  | **源码辅助端** | `3082` | `deepseek-harness` 检出的构建产物 | 试验 dsh 源码新版本（如 0.1.5-rc.2），不动全局安装 |

- **npm 辅助端不再会被检出「抢走」**：旧版按「检出 → DSH_BIN → 安装版 → PATH」解析启动器，只要存在检出就一定用它。现在 npm 辅助端**跳过检出**，固定在已安装的 CLI 上——这正是「改源码时它照样能用」的前提。
- **新增配置项**：`auxPort` / `auxHome`（npm 辅助端）、`auxSourcePort`（默认 `3082`）/ `auxSourceHome` / `auxSourceRepo`（源码辅助端）。空 home = 共用主 home；**测新版本 dsh 时务必给源码辅助端单独设 home**，否则新版的会话格式迁移会改写主 home 的会话。
- **启动失败会显示原因**：面板里直接显示「未找到已安装的 dsh CLI」或「未找到 deepseek-harness 检出」等提示，不再静默失败。
- 附带修复：源码运行（`electron .`）时 `config.json` 不被读取；日志目录不存在时写入静默失败。

### v0.1.2

- **桌面端内置「辅助端」按钮**：桌面窗口右下角多了一个悬浮按钮，可**一键启动 / 打开 / 停止**一个**独立端口（默认 `3081`）**的 dsh 实例——也就是**辅助端**。它和主服务（默认 `3080`，由桌面端独占）是**两个互不影响的服务**：
  - 更新桌面端 / 插件时**不用停掉辅助端**；反过来主用桌面端时，也能在辅助端里**测新功能、试新版本 dsh**，而不必关掉正在用的 dsh。
  - 配置项（`%APPDATA%\dsh-desktop\config.json`）：`auxPort`（默认 `3081`）、`auxHome`（默认空 = 共用主 home；填路径则隔离，**测新版本 dsh 时建议隔离**，避免新版的会话格式迁移影响主 home）。

### v0.1.1

- **`install` 自动下载 exe**：git / npm 渠道不再需要手动下载大 tgz；无内置 exe 时，`dsh-desktop install` 会自动从 GitHub 最新 Release 下载 `DSH-Desktop-*.exe`（私有仓库请设环境变量 `GITHUB_PERSONAL_ACCESS_TOKEN`）。
- **修复：安装版 CLI 无法启动**：桌面壳用 `cmd /c "<dsh.cmd>"` 拉起时，Windows 会把路径里的引号再转义成 `\"...\"`，导致报"不是内部或外部命令"。现已改为不预加引号。
- **修复：关窗后服务残留占用 3080**：关窗时只杀掉了 `cmd` 壳、留下真正的 node 服务变成孤儿进程。现改为关窗时杀掉整棵进程树，真正释放端口。
- **修复：不再自动弹出浏览器**：启动服务时加了 `--no-open`，桌面窗口本身就是界面。

---

## 预览

### 界面

![ScreenShot_2026-08-18_013930_405](./assets/ScreenShot_2026-08-18_013930_405.png)



## 图标

![ScreenShot_2026-08-18_014309_482](./assets/ScreenShot_2026-08-18_014309_482.png)

## 怎么安装（手动安装）

### 你需要先有

- Windows 10 或 11
- **`dsh` 命令能用**（终端里输入 `dsh` 能跑起来）。如果还没装，用 npm 全局安装即可：

  ```sh
  npm install -g @deepseek-ai/dsh
  ```

  装完在终端运行 `dsh --version`，能看到版本号就说明成功了（需要 Node.js ≥ 22，可先用 `node -v` 确认）。
- pnpm（DSH 能用的话，pnpm 一般已经装好了）

### 三步装好

**第 1 步**：到本仓库的 Release 页面，下载 `dsh-desktop-0.1.3.tgz` 文件。

**第 2 步**：打开终端（PowerShell），进入下载目录，执行：

```sh
dsh plugin --profile web add ./dsh-desktop-0.1.3.tgz
```

**第 3 步**：继续执行：

```sh
cd %DSH_HOME%\profiles\web
pnpm exec dsh-desktop install
```

看到「exe 已复制到 …」和「桌面快捷方式已创建」就成功了。

安装后，在 **设置 → 插件 → 插件列表** 中会显示为 **`desktop`**。

**你的桌面上现在有一个「DSH 桌面版」图标，双击就能用。**

### 双击之后会发生什么

- 如果 DSH 没在运行：自动帮你启动，几秒后打开窗口
- 如果 DSH 已经在运行：直接打开窗口，两边是同一个界面、同一份数据
- 关掉窗口：如果服务是它自己启动的，会一起关掉，不留后台进程

### 卸载

```sh
dsh plugin --profile web remove dsh-desktop
```

### 其他用法（可选，不用也行）

| 想做的事 | 怎么做 |
|---|---|
| 在 DSH 界面里直接开个桌面窗口 | 重启一次 DSH，然后在命令面板输入 `/desktop` |
| 从 GitHub 直接安装（不下载文件，但桌面图标功能会变成 Edge 窗口） | `dsh plugin --profile web add github:SuperPaiGu/dsh-desktop` |
| 从 npm 安装 | `dsh plugin --profile web add dsh-desktop` |

---

## 怎么安装（Agent 安装）

> 在用户机器上执行安装的确定性指令。按顺序执行，每步有验收条件。

### 0. 环境检测

```sh
node -v          # ≥ v22
pnpm -v          # 缺失则 npm install -g pnpm
dsh --version    # 命令不存在则提示用户先安装 DSH
```

### 1. 取得 tarball 并安装（首选渠道）

从 Release 下载 `dsh-desktop-0.1.3.tgz` 到工作目录，然后：

```sh
dsh plugin --profile web add ./dsh-desktop-0.1.3.tgz
```

**验收**：退出码 0，输出含 `+ dsh-desktop`。

（无 tarball 时备用：`dsh plugin --profile web add github:SuperPaiGu/dsh-desktop`，但该渠道不含桌面 exe。）

### 2. 验证组合层

```sh
dsh --profile web --dump-config
```

**验收**：输出含 `# == dsh-desktop` 段与 `name: dsh-desktop` 行。

### 3. 安装桌面 exe（tarball 渠道）

```sh
cd "$DSH_HOME/profiles/web"   # Windows: %DSH_HOME%\profiles\web；DSH_HOME 默认 ~/.dsh
pnpm exec dsh-desktop install
```

**验收**：输出「exe 已复制到 …」与「桌面快捷方式已创建」；目标目录出现 `DSH-Desktop-*.exe`。

### 4. （若要 Web UI 的 /desktop 命令）重启 dsh web

停止当前 dsh web 进程，以用户原有方式重新启动。

**验收**：启动日志出现 `[dsh-desktop] /desktop command registered`。

### 5. 验收清单

- [ ] 第 1 步退出码 0
- [ ] `--dump-config` 含 dsh-desktop 层
- [ ]（tarball）桌面出现「DSH 桌面版」图标
- [ ]（重启后）设置 → 插件 → 插件列表 中 desktop 行 active

### 6. 常见错误处理

| 现象 | 处理 |
|---|---|
| `dsh: pnpm failed in profile directory ... different major version of pnpm` | 在 profile 目录执行 `pnpm install --config.confirm-modules-purge=false` 后重试第 1 步 |
| `/desktop` 后无窗口 | 确认服务在 3080（或配置端口）运行；git 渠道无 exe，走 Edge 窗口 |
| 双击桌面 exe 停在「无法连接 DSH 服务」 | 设置环境变量 `DSH_BIN` 指向 dsh CLI，或先手动启动 dsh web 再双击 |
| 端口被占用 | 改 `%APPDATA%\dsh-desktop\config.json` 的 `port`，或关闭占用者 |

### 7. 环境变量参考

- `DSH_HOME`：dsh 主目录（默认 `~/.dsh`）
- `DSH_BIN`：桌面 exe 拉起服务用的 dsh CLI 路径（探测不到时才需要）
- `DSH_DESKTOP_REPO`：桌面 exe 自建服务用的 deepseek-harness 检出路径

---

## 从源码构建桌面 exe（给开发者，可选）

```sh
cd desktop
pnpm install     # 首次需联网（electron ~120MB）
pnpm run dist    # 产出 dist/DSH-Desktop-<版本>-x64.exe
```

注意：打包前关闭正在运行的桌面 exe；自定义图标放 `desktop/build/icon.ico`（没有则用默认图标）。

## 目录结构

```
dsh-desktop/            组合包根
├── package.json        dsh.bundle 声明
├── cordis.patch.yml    插件层（id desktop → dsh-desktop）
├── index.js            /desktop 命令（纯 JS，无构建步骤）
├── bin/                dsh-desktop 命令（run / install / help）
└── desktop/            Electron 桌面壳（探测→接入→自建→跟随退出）
```

## 已知限制

- 仅 Windows
- 独立双击 exe 的自建服务需要能找到 dsh CLI（按 检出 → DSH_BIN → 安装版 .bin/dsh → PATH 顺序探测）；找不到时先启动 dsh web 再双击
