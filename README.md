# QQ 农场多账号挂机 + Web 面板

## 作者QQ：1503938233 -- 付费版请咨询
- 基于 Node.js 的 QQ 农场自动化工具，支持多账号管理、Web 控制面板、实时日志与数据分析。
- 更新优化日志详见 update.log，感谢支持，喜欢的点一个 star⭐吧！
- 默认账号密码都是 `admin/admin`，端口 `3007`，**请部署登录后尽快修改密码！**
- 重构版 V2.5.1 完整更新日志详见：[更新日志](https://gitee.com/xlzcandy/qq-classic-farm-update-log/blob/master/README.md)
- 请不要贩卖开源版本，免费项目，禁止倒卖！所有功能都是正常使用的。
- 目前官方已关闭三分钟风控，开源版正常偷菜。内置 yyb_go 开源应用宝协议，供微信玩家使用。

---

## 功能特性

- **农场自动化**：收获、种植（含背包优先策略）、浇水、除草除虫、铲除、施肥、土地自动升级
- **仓库**：收获后自动出售果实
- **好友**：自动偷菜 / 帮忙 / 捣乱（放虫放草）、好友黑名单
- **任务**：每日任务与活跃度自动领取、图鉴一键领奖、邮件、月卡、会员/免费礼包
- **微信登录**：yyb-go 应用宝协议扫码登录（免费、无第三方 API），启动自动刷新 code
- **自动重登**：被踢下线后延迟自动重登（防循环，面板可配，默认关闭）
- **版本号自动校准**：客户端版本日期自动更新 + 服务端版本前缀自动同步，**无需手动维护**
- **活动种子支持**：活动种子自动识别种植、面板图标显示
- **多账号**：账号管理、实时日志筛选、暗色/亮色主题、分析页（经验/利润效率排序）

---

## 技术栈

**后端**：[Node.js 20+](https://nodejs.org/) · [Express 4](https://expressjs.com/) · [Socket.io 4](https://socket.io/)

**前端**：[Vue 3](https://vuejs.org/) · [Vite](https://vitejs.dev/) · [TypeScript](https://www.typescriptlang.org/) · [Pinia](https://pinia.vuejs.org/) · [UnoCSS](https://unocss.dev/)

**部署**：[pnpm 10](https://pnpm.io/) · [Docker Compose](https://docs.docker.com/compose/)

---

## 环境要求

- Docker 部署：安装 Docker（含 Docker Compose 插件）
- 源码运行：Node.js 20+、pnpm（`corepack enable` 启用）、Git

---

## 快速开始（Docker 部署，推荐）

> 仓库编排了两个服务：`qq-farm-bot`（农场自动化）与 `yyb-go`（微信扫码登录）。一条命令完成部署。

### 1. 拉取代码（两个仓库同级）

```bash
# 农场主程序
git clone https://github.com/XyhTender/qq-farm-automation-bot.git

# 微信登录服务（构建上下文在上一级目录，必须 clone 到同级）
git clone https://github.com/Aoluis1005/yyb-go.git

# 目录结构应为：
#   your-dir/
#   ├── qq-farm-automation-bot/
#   └── yyb-go/
```

### 2. 构建并启动

```bash
cd qq-farm-automation-bot
docker compose up -d --build
```

首次构建需拉取基础镜像与依赖，约几分钟。启动后：

```bash
# 查看状态
docker ps                              # qq-farm-bot / yyb-go 均为 Up
docker compose logs -f qq-farm-bot     # 农场服务日志
docker compose logs -f yyb-go          # 微信登录服务日志
```

### 3. 访问面板

浏览器打开 `http://<你的IP>:3007`（本机为 `http://localhost:3007`），默认账号 `admin/admin`，**登录后立即修改密码**。

### 4. 添加账号并开始挂机

1. 面板 → **设置 → 账号管理 → 添加账号**
2. QQ 玩家：手动填码；微信玩家：**微信扫码**（手机微信扫 → 应用宝授权页确认）
3. 账号卡片点「启动」→ 开始挂机（默认不自动启动，需手动点一次）

### 常用命令

```bash
docker compose down                    # 停止
docker compose up -d --build           # 更新后重建（改代码后必须重建才生效）
docker compose down -v                 # 停止并删除数据卷（会清空账号，慎用）
```

### 数据持久化

账号、配置、日志存在 Docker 数据卷（`qq-farm-data` / `qq-farm-logs`），`down` 不会删除，重装/重启不丢数据。

---

## 源码本地运行

> 源码方式与 Docker 不能同时占用 3007 端口。微信登录同样需要 yyb-go（见下文）。

### macOS / Linux

```bash
# 1. 安装依赖并构建前端
cd qq-farm-automation-bot
pnpm install
pnpm build:web

# 2. 启动后端（必须在 core/ 目录下）
cd core && node client.js

# 3. 浏览器访问 http://localhost:3007
```

### Windows

```powershell
# 1. 安装 Node.js 20+ 并启用 pnpm
node -v
corepack enable
pnpm -v

# 2. 安装依赖并构建前端
cd D:\Projects\qq-farm-automation-bot
pnpm install
pnpm build:web

# 3. 启动
pnpm dev:core

# （可选）指定端口
$env:ADMIN_PORT="你的新端口"
pnpm dev:core
```

### 微信登录（源码方式）

微信扫码登录依赖 yyb-go 服务。源码运行需要额外启动它：

```bash
# 在 yyb-go 仓库目录
cd ../yyb-go
go build -o yyb-go .        # 或按 yyb-go 仓库说明启动
./yyb-go                    # 默认监听 8000

# 回到主程序，指定 yyb-go 地址后启动
cd ../qq-farm-automation-bot/core
YYB_GO_BASE=http://127.0.0.1:8000 node client.js
```

---

## 登录与安全

- 面板默认管理账号：`admin/admin`（端口 3007）
- **部署后立即修改密码**（面板 → 设置 → 用户管理）
- 面板不要直接暴露公网；如必须远程访问，请置于反向代理 + HTTPS 之后

---

## 微信扫码登录（yyb-go 应用宝协议）

微信端登录由独立服务 **yyb-go**（应用宝协议，[Aoluis1005/yyb-go](https://github.com/Aoluis1005/yyb-go)，Farm5 兼容）提供。本仓库已内置对接适配层（`core/src/services/yyb-proxy.js`），无需第三方付费 API。

### 添加微信账号

1. 面板 → **设置 → 账号管理 → 添加账号 → 微信扫码**
2. 手机微信扫码 → 应用宝授权页确认
3. 自动添加账号（平台 `wx`，保存 openid 与微信头像）

### 微信配置（设置 → 管理面板 → 微信登录配置）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `apiBase` | `/api` | 同源代理到 yyb-go，**不要改成外部地址** |
| `apiKey` | **留空** | 留空 = 走本地 yyb-go；填入 = 走第三方付费 API |
| `appId` | `wx5306c5978fdb76e4` | 游戏小程序 ID，勿改 |
| `autoAddAccount` | `true` | 扫码后自动添加账号 |

### 自动重新登录（重要）

微信 `wx.login` code 短时效。本仓库已实现：**启动账号时自动通过 yyb-go 刷新 code**。

- 手机玩过、bot 被踢下线后 → 面板点「启动」→ 自动刷新 code 直连，无需重新扫码
- 前提：账号需存有 `wxid`（新添加的微信账号自动保存；旧账号删除后重新扫码一次即可）

### 多端互踢说明

游戏服务端为**单会话互踢**：手机登录时 bot 会被踢下线并自动停止（官方客户端优先）。手机玩完，面板点「启动」恢复挂机即可。

---

## 自动重登（面板可配，默认关闭）

账号被踢下线后，可配置**延迟自动重登**（防循环保护）：

- 面板 → **设置 → 策略设置 → 自动重登设置**
- 参数：延迟分钟数（默认 15）、每日上限（默认 3 次）、重登窗口（10 分钟内再被踢则当日禁用）、登录失败窗口（60 秒内退出则当日禁用）
- 默认关闭；开启后：手机玩完踢掉 bot → 自动重登恢复挂机

---

## 版本号维护（已自动，一般无需操作）

游戏服务端校验客户端版本（按日期部分）。本仓库已实现**版本号自动校准**：

- 日期段：启动时按当天日期动态生成
- 前缀段：登录/心跳时从服务端 `version_info` 自动同步并持久化

正常使用**无需手动修改**。仅当长期停跑、登录都进不去时，手动改 `core/src/config/config.js` 的 `clientVersion`（如 `1.11.1.7_20260803`，日期改成当天）并重建：

```bash
docker compose up -d --build
```

---

## 项目结构

```
qq-farm-automation-bot/
├── core/                  # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/        # 配置管理
│   │   ├── controllers/   # HTTP API
│   │   ├── gameConfig/    # 游戏静态数据（含种子图标）
│   │   ├── models/        # 数据模型与持久化
│   │   ├── proto/         # Protobuf 协议定义
│   │   ├── runtime/       # 运行时引擎与 Worker 管理
│   │   └── services/      # 业务逻辑（农场、好友、任务等）
│   ├── data/              # 运行时数据（accounts.json、store.json，勿提交）
│   └── client.js          # 主进程入口
├── scripts/               # 工具脚本（如种子图标同步 sync-seed-assets.mjs）
├── web/                   # 前端（Vue 3 + Vite）
│   └── src/               # api / components / stores / views
├── docker-compose.yml     # 编排 qq-farm-bot + yyb-go
└── package.json           # pnpm workspace
```

---

## 常见问题（FAQ）

**Q: 挂机需要一直开着面板网页吗？**
A: 不需要。服务跑在 Docker 容器里，网页只是管理界面，关掉不影响挂机。容器 `restart: unless-stopped` 开机自启。

**Q: Mac/服务器重启后账号会自动恢复吗？**
A: 容器自动恢复，但账号默认**不自动启动**（`autoStartAccounts: false`）。需要开机即挂机可改为 `true` 并重建；或重启后在面板点「启动」。

**Q: 手机登录会影响挂机吗？**
A: 游戏单会话互踢：手机登录会把 bot 踢下线（bot 自动停止），手机优先。玩完在面板点「启动」恢复（自动刷新 code，无需重新扫码）；或开启「自动重登」自动恢复。

**Q: 启动时报 `Unexpected server response: 400` / 连接被拒绝？**
A: 微信 code 过期。新版本启动时会自动刷新 code（需账号有 `wxid`）；若仍失败，删除账号重新扫码添加一次。

**Q: 日志出现「客户端版本过低」被踢？**
A: 版本号已自动校准，一般不会出现。若出现，手动更新 `config.js` 的 `clientVersion` 日期为当天并重建，详见「版本号维护」。

**Q: 为什么种子图标显示不出来？**
A: 种子图标随游戏资源按需下载。活动新种子需先在游戏里种植/查看一次，然后运行 `node scripts/sync-seed-assets.mjs` 同步图标（详见脚本注释）。

**Q: 赛季活动（战令/观星/神秘商店）能自动吗？**
A: 不能。开源版覆盖：收获/种植/浇水/除草除虫/偷菜、每日任务与活跃度自动领取、图鉴一键领奖、邮件、月卡、化肥自动购买。活动类功能为付费版专有。

**Q: 为什么前端要保留 `apiKey` 留空？**
A: 留空走仓库内置的 yyb-go 本地通道（免费、无第三方依赖）；填入 apiKey 才会启用外部代理模式。

**Q: Docker 构建 yyb-go 失败（找不到上下文）？**
A: `docker-compose.yml` 中 yyb-go 的构建上下文是 `../yyb-go`（上一级目录），需先将 yyb-go 仓库 clone 到与主仓库同级，见「快速开始」。

---

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。
