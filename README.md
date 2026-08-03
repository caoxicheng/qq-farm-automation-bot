# QQ 农场多账号挂机 + Web 面板
## 作者QQ：1503938233--付费版请咨询
- 基于 Node.js 的 QQ 农场自动化工具，支持多账号管理、Web 控制面板、实时日志与数据分析。
- 更新优化日志详见update.log 感谢支持，喜欢的点一个star⭐吧！
- 默认账号密码都是admin，端口3007，请部署登录后尽快修改密码！
- 重构版V2.5.1完整更新日志详见：[更新日志](https://gitee.com/xlzcandy/qq-classic-farm-update-log/blob/master/README.md)
### 请不要贩卖开源版本，免费项目，禁止倒卖！所有功能都是正常使用的，只需要更新一下core/src/config/config.js里面的版本号然后重启后端即可，一定要重启后端，docker部署的需要删除容器重新构建才生效。
### 目前官方已经把三分钟风控给关了，所以开源版也正常偷菜了，八月会对开源版进行一次小更新，更新资源包到最新版本同时务农接口也更新到最新接口。内置一个yyb_go的开源应用宝协议，供微信玩家使用~
---
## 技术栈

**后端**

[<img src="https://skillicons.dev/icons?i=nodejs" height="48" title="Node.js 20+" />](https://nodejs.org/)
[<img src="https://skillicons.dev/icons?i=express" height="48" title="Express 4" />](https://expressjs.com/)
[<img src="https://skillicons.dev/icons?i=socketio" height="48" title="Socket.io 4" />](https://socket.io/)

**前端**

[<img src="https://skillicons.dev/icons?i=vue" height="48" title="Vue 3" />](https://vuejs.org/)
[<img src="https://skillicons.dev/icons?i=vite" height="48" title="Vite 7" />](https://vitejs.dev/)
[<img src="https://skillicons.dev/icons?i=ts" height="48" title="TypeScript 5" />](https://www.typescriptlang.org/)
[<img src="https://cdn.simpleicons.org/pinia/FFD859" height="48" title="Pinia 3" />](https://pinia.vuejs.org/)
[<img src="https://skillicons.dev/icons?i=unocss" height="48" title="UnoCSS" />](https://unocss.dev/)

**部署**

[<img src="https://skillicons.dev/icons?i=pnpm" height="48" title="pnpm 10" />](https://pnpm.io/)
[<img src="https://skillicons.dev/icons?i=githubactions" height="48" title="GitHub Actions" />](https://github.com/features/actions)

---
## 环境要求

- 源码运行：Node.js 20+，pnpm（推荐通过 `corepack enable` 启用）
- 二进制发布版：无需安装 Node.js

## 安装与启动（源码方式）

### Windows

```powershell
# 1. 安装 Node.js 20+（https://nodejs.org/）并启用 pnpm
node -v
corepack enable
pnpm -v

# 2. 安装依赖并构建前端
cd D:\Projects\qq-farm-bot-ui
pnpm install
pnpm build:web

# 3. 启动
pnpm dev:core

# （可选）设置其他端口后启动
$env:ADMIN_PORT="你的新端口"
pnpm dev:core
```

### Linux（Ubuntu/Debian）
建议使用宝塔最为便捷，在网站其他项目选项中按照如图所示去部署即可

<img src="https://free.picui.cn/free/2026/03/27/69c6398dd326c.png"  alt="图片失效"/>

启动后访问面板：
- 本机：`http://localhost:3007`
- 局域网：`http://<你的IP>:3007`

---

## Docker 部署（拉取不了镜像直接下载压缩包解压即可）
> 本仓库的 `docker-compose.yml` 已编排两个服务：`qq-farm-bot`（农场自动化）与 `yyb-go`（微信扫码登录，应用宝协议）。一条命令即可完成微信端全部部署。
```
# 拉取仓库
git clone https://github.com/XyhTender/qq-farm-automation-bot.git

# 进入目录
cd /qq-farm-automation-bot-main

# 构建并后台启动（同时构建 qq-farm-bot + yyb-go 两个镜像）
docker compose -f docker-compose.yml up -d --build

# 查看日志
docker compose logs -f
docker compose logs -f yyb-go      # 微信登录服务日志

# 停止并移除容器
docker compose down

# 浏览器访问http://你的IP:3007
```

> 注：yyb-go 镜像构建上下文为 `../yyb-go`（需与 yyb-go 仓库同级），或自行 clone 到该路径：
> ```bash
> git clone https://github.com/Aoluis1005/yyb-go.git ../yyb-go
> ```

## 二进制发布版（无需 Node.js）

### 构建

```bash
pnpm install
pnpm package:release
```

产物输出在 `dist/` 目录：
- `产物在Releases中也可以下载，无需自己构建`

| 平台 | 文件名 |
|------|--------|
| Windows x64 | `qq-farm-bot.exe` |
| Linux x64 | `qq-farm-bot` |
| macOS Intel | `qq-farm-bot-x64` |
| macOS Apple Silicon | `qq-farm-bot-arm64` |

### 运行

```bash
# Windows：双击 exe 或在终端执行
.\qq-farm-bot-win-x64.exe

# Linux / macOS
chmod +x ./qq-farm-bot && ./qq-farm-bot
```

程序会在可执行文件同级目录自动创建 `data/` 并写入 `store.json`、`accounts.json`。

---

## 登录与安全

- 面板首次访问需要登录
- 默认管理账号：`admin/admin`
- **建议部署后立即修改为强密码**

---

## 微信扫码登录（yyb-go 应用宝协议）

微信端登录由独立服务 **yyb-go**（应用宝协议，[Aoluis1005/yyb-go](https://github.com/Aoluis1005/yyb-go)，Farm5 兼容）提供：微信扫码 → 应用宝授权 → 自动添加账号。本仓库已内置对接适配层（`core/src/services/yyb-proxy.js`），无需任何第三方付费 API。

### 添加微信账号

1. 面板 → **设置 → 账号管理 → 添加账号 → 微信扫码登录**
2. 手机微信扫码 → 应用宝授权页确认
3. 自动添加账号（平台 `wx`，同时保存 openid）

### 微信配置（设置 → 管理面板 → 微信登录配置）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `apiBase` | `/api` | 同源代理到 yyb-go，**不要改成外部地址** |
| `apiKey` | **留空** | 留空 = 走本地 yyb-go；填入 = 走第三方付费 API |
| `appId` | `wx5306c5978fdb76e4` | 游戏小程序 ID，勿改 |
| `autoAddAccount` | `true` | 扫码后自动添加账号 |

### 自动重新登录（重要）

微信 `wx.login` code 短时效。本仓库已实现：**启动账号时自动通过 yyb-go 刷新 code**（`startAccount` 会先调 `/wxapp/getCode` 拿全新 code 再连接）。

- 手机玩过、bot 被踢下线后 → 面板点「启动」→ **自动刷新 code 直连，无需重新扫码**
- 前提：账号需存有 `wxid`（新添加的微信账号自动保存；旧账号删除后重新扫码一次即可）

### 多端互踢说明

游戏服务端为**单会话互踢**：手机登录时 bot 会被踢下线并自动停止（官方客户端优先）。手机玩完，面板点「启动」恢复挂机即可。不建议开启自动重连（会反踢手机）。

---

## 版本号维护（客户端版本过低）

游戏服务端校验客户端版本（按日期部分）。若日志出现：

```
系统被踢下线! gatepb.KickoutNotify
系统原因: 客户端版本过低，请升级到最新版本。
```

更新 `core/src/config/config.js` 中的 `clientVersion` 日期为当前日期并重启/重建：

```js
clientVersion: '1.11.1.7_20260803',   // 日期部分改成当天
```

Docker 部署需重新构建：`docker compose up -d --build`。

---

## 项目结构

```
qq-farm-bot-ui/
├── core/                  # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/        # 配置管理
│   │   ├── controllers/   # HTTP API
│   │   ├── gameConfig/    # 游戏静态数据
│   │   ├── models/        # 数据模型与持久化
│   │   ├── proto/         # Protobuf 协议定义
│   │   ├── runtime/       # 运行时引擎与 Worker 管理
│   │   └── services/      # 业务逻辑（农场、好友、任务等）
│   ├── data/              # 运行时数据（accounts.json、store.json）
│   └── client.js          # 主进程入口
├── web/                   # 前端（Vue 3 + Vite）
│   ├── src/
│   │   ├── api/           # API 客户端
│   │   ├── components/    # Vue 组件
│   │   ├── stores/        # Pinia 状态管理
│   │   └── views/         # 页面视图
│   └── dist/              # 构建产物
├── pnpm-workspace.yaml
└── package.json
```

## 常见问题（FAQ）

**Q: 挂机需要一直开着面板网页吗？**
A: 不需要。服务跑在 Docker 容器里，网页只是管理界面，关掉不影响挂机。容器 `restart: unless-stopped` 开机自启。

**Q: Mac/服务器重启后账号会自动恢复吗？**
A: 容器会自动恢复，但账号默认**不自动启动**（`core/client.js` 中 `autoStartAccounts: false`）。如需开机即挂机，改为 `true` 并重建。

**Q: 手机登录会影响挂机吗？**
A: 游戏单会话互踢：手机登录会把 bot 踢下线（bot 自动停止），手机优先。玩完在面板点「启动」恢复（自动刷新 code，无需重新扫码）。

**Q: 启动时报 `Unexpected server response: 400` / 连接被拒绝？**
A: 微信 code 过期。新版本已支持启动时自动刷新 code（需账号有 `wxid`）；若仍失败，删除账号重新扫码添加一次。

**Q: 日志出现「客户端版本过低」被踢？**
A: 更新 `config.js` 的 `clientVersion` 日期为当天，重建容器。详见「版本号维护」章节。

**Q: 赛季活动（战令/观星/神秘商店）能自动吗？**
A: 不能。开源版覆盖：收获/种植/浇水/除草除虫/偷菜、每日任务与活跃度自动领取、图鉴一键领奖、邮件、月卡、化肥自动购买。活动类功能为付费版专有，需手动操作。

**Q: 为什么前端要保留 `apiKey` 留空？**
A: 留空走仓库内置的 yyb-go 本地通道（免费、无第三方依赖）；填入 apiKey 才会启用外部代理模式。

---

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。
