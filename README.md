# QQ 农场多账号挂机 + Web 面板

基于 Node.js 的 QQ 农场自动化工具，支持多账号管理、Web 控制面板、实时日志、数据分析与活动支持（千星游记/战令/神秘商人）。

> 📖 喜欢的点一个 star ⭐ 吧！
>
> 🔐 默认面板管理员账号/密码都是 `admin`，端口 `3007`，请部署登录后尽快修改密码！
>
> ⚠️ 开源免费，禁止倒卖，请勿用于商业用途。

---

## 功能特性

### 🌾 核心功能

- **农场自动化** — 收获、种植（含背包优先策略、2x2 主格种植）、浇水、除草除虫、铲除、施肥、土地自动升级
- **仓库管理** — 收获后自动出售果实、活动果实分类与图片显示
- **好友互动** — 自动偷菜 / 帮忙 / 捣乱（放虫放草，面板开关）、好友黑名单、访客自动同步
- **任务系统** — 每日任务与活跃度自动领取、图鉴一键领奖、邮件、月卡、会员/免费礼包
- **微信登录** — yyb-go 应用宝协议扫码登录（免费、无第三方 API），启动自动刷新 code，微信头像显示
- **自动重登** — 被踢下线后延迟自动重登（防循环，面板可配，默认关闭）
- **版本自动校准** — 客户端版本日期自动更新 + 服务端版本前缀自动同步，无需手动维护
- **多账号管理** — 账号独立配置、实时日志筛选、暗色/亮色主题、分析页（经验/利润效率排序）

### 🎮 活动支持

- **千星游记/战令** — 赛季协议支持，进度奖励自动领取（先查后领 + 推送驱动，面板开关，默认关闭）
- **神秘商人** — 限时 NPC 商品查询/购买（动态渲染 + 倒计时 + 余额判断，侧边栏独立页面）
- **ACE 反作弊模拟** — TSDK wasm 定时 AntiData 上报，避免服务端挂起连接

### 🖼️ 资源与展示

- **活动种子** — 活动种子自动识别种植、面板图标显示
- **果实图片同步** — 成熟果实图片自动同步（本地卷挂载 + crontab 定时）

---

## 特别感谢

- **[XyhTender/qq-farm-automation-bot](https://github.com/XyhTender/qq-farm-automation-bot)** — 本项目 fork 来源
- **[Penty-d/qq-farm-bot-ui](https://github.com/Penty-d/qq-farm-bot-ui)** — 上游二改基础
- **[linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot)** — 核心功能
- **[QianChenJun/qq-farm-bot](https://github.com/QianChenJun/qq-farm-bot)** — 部分功能
- **[liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot)** — 赛季/活动协议结构与 ACE 反作弊 TSDK wasm 模拟上报
- **[Aoluis1005/yyb-go](https://github.com/Aoluis1005/yyb-go)** — 微信登录应用宝协议

在此向以上项目作者表示感谢 🙏

---

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。请勿用于商业用途或倒卖。

---

## 技术栈

**后端**

[<img src="https://skillicons.dev/icons?i=nodejs" height="48" title="Node.js 20+" />](https://nodejs.org/)
[<img src="https://skillicons.dev/icons?i=express" height="48" title="Express 4" />](https://expressjs.com/)
[<img src="https://skillicons.dev/icons?i=socketio" height="48" title="Socket.io 4" />](https://socket.io/)

**前端**

[<img src="https://skillicons.dev/icons?i=vue" height="48" title="Vue 3" />](https://vuejs.org/)
[<img src="https://skillicons.dev/icons?i=vite" height="48" title="Vite" />](https://vitejs.dev/)
[<img src="https://skillicons.dev/icons?i=ts" height="48" title="TypeScript" />](https://www.typescriptlang.org/)
[<img src="https://cdn.simpleicons.org/pinia/FFD859" height="48" title="Pinia" />](https://pinia.vuejs.org/)
[<img src="https://skillicons.dev/icons?i=unocss" height="48" title="UnoCSS" />](https://unocss.dev/)

**部署**

[<img src="https://skillicons.dev/icons?i=pnpm" height="48" title="pnpm" />](https://pnpm.io/)
[<img src="https://skillicons.dev/icons?i=docker" height="48" title="Docker Compose" />](https://docs.docker.com/compose/)
[<img src="https://skillicons.dev/icons?i=github" height="48" title="GitHub" />](https://github.com/)

---

## 项目结构

```
qq-farm-automation-bot/
├── core/                          # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/                # 配置管理 & 游戏配置（版本号/图片映射）
│   │   ├── controllers/           # HTTP API 路由（账号、农场、好友、认证等）
│   │   ├── core/                  # Worker 进程管理
│   │   ├── gameConfig/            # 游戏静态数据
│   │   │   └── seed_images_named/ # 种子/果实图片资源（本地卷挂载，crontab 自动同步）
│   │   ├── models/                # 全局配置与账号持久化
│   │   ├── proto/                 # Protobuf 协议定义（19 个 .proto）
│   │   ├── runtime/               # 运行时引擎、状态管理、Worker 调度
│   │   ├── services/              # 业务逻辑（farm/warehouse/friend/task/mall/season/ace 等）
│   │   └── utils/                 # 工具（网络、Proto 解析、ACE 反作弊 TSDK WASM）
│   └── data/                      # 运行时数据（账号、用户、日志等）
├── web/                           # 前端（Vue 3 + Vite + TypeScript）
│   └── src/
│       ├── api/                   # API 客户端 & Socket.io 连接
│       ├── components/            # 通用组件（BaseSwitch/BaseInput/LandCard/BagPanel 等）
│       ├── layouts/               # 页面布局
│       ├── stores/                # Pinia 状态管理
│       └── views/                 # 页面（概览/个人/好友/分析/设置/后台）
├── scripts/                       # 工具脚本（sync-seed-assets 图片同步等）
├── docker-compose.yml             # 一键部署（qq-farm-bot + yyb-go 微信登录）
└── README.md
```

---

## 环境要求

| 部署方式 | 要求 |
| --- | --- |
| Docker 部署 | Docker（含 Docker Compose 插件） |
| 源码运行 | Node.js 20+ · pnpm（`corepack enable` 启用）· Git |

---

## 快速开始（Docker 部署，推荐）

> 仓库编排了两个服务：`qq-farm-bot`（农场自动化）与 `yyb-go`（微信扫码登录）。一条命令完成部署。

### 1. 拉取代码（两个仓库同级）

```bash
# 农场主程序（本仓库）
git clone https://github.com/caoxicheng/qq-farm-automation-bot.git

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

正常使用**无需手动修改**。仅当长期停跑、登录都进不去时，手动改 `core/src/config/config.js` 的 `clientVersion`（如 `1.11.1.7_20260806`，日期改成当天）并重建：

```bash
docker compose up -d --build
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

**Q: 赛季活动（战令/千星游记）能自动吗？**
A: 战令进度奖励支持自动领取（先查后领 + 推送驱动，面板「自动控制」可开关，默认关闭）。观星点亮、星砂商店兑换、节令小礼等更多活动功能仍在开发中。

**Q: 为什么前端要保留 `apiKey` 留空？**
A: 留空走仓库内置的 yyb-go 本地通道（免费、无第三方依赖）；填入 apiKey 才会启用外部代理模式。

**Q: Docker 构建 yyb-go 失败（找不到上下文）？**
A: `docker-compose.yml` 中 yyb-go 的构建上下文是 `../yyb-go`（上一级目录），需先将 yyb-go 仓库 clone 到与主仓库同级，见「快速开始」。

---
