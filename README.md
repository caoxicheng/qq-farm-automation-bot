# QQ 农场多账号挂机 + Web 面板

基于 Node.js 的 QQ 农场自动化工具，提供多账号管理、微信扫码登录、Web 控制面板、实时日志、数据分析和活动支持。

> 默认管理员账号和密码均为 `admin`，服务端口为 `3007`。首次登录后请立即修改密码。
>
> 本项目开源免费，仅供学习与研究，禁止倒卖或用于商业用途。

## 功能

- **农场自动化**：收获、种植、浇水、除草除虫、铲除、施肥和土地升级
- **仓库与好友**：自动出售、背包优先种植、偷菜、帮忙、捣乱和好友黑名单
- **任务与活动**：每日任务、活跃度、图鉴、邮件、月卡、礼包、千星游记、观星、青梅活动和神秘商人自动购买
- **微信登录**：内置应用宝扫码协议，无需额外登录服务
- **多账号管理**：账号独立策略、实时日志、运行状态和数据分析
- **运行自愈**：Worker 看护、掉线停止和可配置的延迟自动重登
- **静态资源包**：物品名称和图片随代码及 Docker 镜像发布，运行时不访问微信缓存或 CDN

## 快速开始

推荐使用 Docker Compose。需要 Docker（含 Compose 插件）和 Git。

```bash
git clone https://github.com/caoxicheng/qq-farm-automation-bot.git
cd qq-farm-automation-bot
docker compose up -d --build
```

浏览器访问 `http://localhost:3007`；远程部署时将 `localhost` 替换为服务器地址。

登录后前往 **设置 → 账号管理**：QQ 玩家可手动填码，微信玩家可扫码添加。账号添加后点击“启动”开始挂机。

神秘商人自动购买默认关闭；需要时可在对应账号的 **设置 → 自动控制 → 自动购买神秘商品** 中开启。商人出现后 Bot 会按服务端推送自动购买当前整份商品，并避免对同一轮商品重复下单。

常用命令：

```bash
docker compose ps                   # 查看状态
docker compose logs -f qq-farm-bot  # 查看日志
docker compose up -d --build        # 拉取改动后重新构建
docker compose down                 # 停止服务，保留数据
```

账号、配置和日志保存在 `qq-farm-data`、`qq-farm-logs` 数据卷中。不要随意执行 `docker compose down -v`，该命令会删除数据卷。

## 微信登录与自动重登

微信扫码登录由进程内置协议实现，不需要 Go 服务、第三方 API 或额外容器。

1. 打开 **设置 → 账号管理 → 添加账号 → 微信扫码**。
2. 使用手机微信扫码并在应用宝授权页确认。
3. 系统保存登录凭证并添加账号。

已保存有效会话凭证的账号，重新启动时会自动刷新短时效 code，通常无需再次扫码。旧账号缺少 `wxid` 或凭证已经失效时，需要删除后重新扫码一次。

游戏为单会话机制，手机登录会将 Bot 踢下线。手机使用结束后可手动启动账号，也可在 **设置 → 策略设置 → 自动重登设置** 中开启延迟重登。自动重登默认关闭，并包含每日上限和防循环保护。

## 源码运行

需要 Node.js 20+、pnpm 和 Git。源码服务与 Docker 服务不能同时占用 `3007` 端口。

```bash
corepack enable
pnpm install
pnpm build:web
pnpm dev:core
```

常用开发命令：

```bash
pnpm lint                         # Core 与 Web lint
pnpm -C core typecheck           # Core 源码与 TypeScript 测试类型检查
pnpm -C core test                # 编译后运行 Core 回归测试
pnpm build                       # 构建 Web 与 Core
pnpm game-data check             # 校验随版本发布的游戏资源
```

Core 测试使用 Node.js 内置的 `node:test`。`pnpm -C core test` 会先重新编译源码和测试，再运行完整回归；提交后端改动前建议依次执行类型检查、Core 测试和完整构建。

本地多平台可执行文件打包命令为 `pnpm package:win`、`pnpm package:linux`、`pnpm package:mac`；一次生成全部发布目标使用 `pnpm package:release`。这些命令都会先构建 Web，再编译 TypeScript Core。

Docker 修改后的完整验收可执行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f qq-farm-bot
```

资源同步仅供项目维护者在 macOS 上使用。普通用户只需运行 Bot，静态资源已经包含在仓库和镜像中。

## 项目结构

```text
qq-farm-automation-bot/
├── .agents/skills/                 # 仓库共享的 Codex Skills
├── core/                           # Node.js 后端与机器人引擎
│   ├── client.ts                   # TypeScript 服务入口
│   ├── Dockerfile                  # 多阶段生产镜像
│   ├── resources/game-data/        # 随版本发布的物品目录和内容寻址图片
│   ├── src/
│   │   ├── gameConfig/             # 价格、出售和种植等原始业务配置
│   │   ├── game-data/              # 发布资源包加载与查询
│   │   ├── runtime/                # Worker API、自动巡查、状态同步和重登状态
│   │   ├── services/               # 农场、好友、任务、活动和微信登录领域服务
│   │   └── controllers/            # 分领域的管理面板 HTTP 与 Socket.io API
│   ├── test/                        # 协议、领域服务、运行时与资源系统回归测试
│   ├── tools/                       # 协议分析工具
│   └── data/                        # 运行时生成的数据（Git 忽略，Docker 卷持久化）
├── web/
│   ├── public/                      # 图标和活动静态资源
│   └── src/                         # Vue 3 管理面板
├── scripts/game-data/               # macOS 资源同步实现
├── scripts/game-data.mjs            # game-data CLI 入口
├── artifacts/                       # 资源同步报告等开发产物
├── docs/                            # 协议分析与开发文档
├── docker-compose.yml               # 默认部署配置
├── docker-compose.dev.yml           # 维护者资源包挂载覆盖
├── package.json                     # Workspace 与开发命令
├── CHANGELOG.md                     # 版本更新日志
└── TODO.md                          # 未完成工程事项
```

## 后端架构与测试

每个游戏账号运行在独立 Worker 中，主进程通过统一 API 调度账号操作。管理面板路由按账号、玩法、日志和登录等领域拆分；Socket 鉴权与账号房间订阅独立维护。农场和好友模块将流程编排与地块判断、种植策略、好友目录及操作限额分开，Worker 的 API、自动巡查、状态同步和每日礼包也各自保持单一职责。

Core 回归测试重点覆盖：

- 协议请求编码与农场、好友领域规则
- 管理接口和 Socket 的身份鉴权、账号隔离
- Worker API 契约、调度顺序、异常恢复和状态去重
- 随版本发布的游戏资源完整性

未完成的工程事项统一记录在 `TODO.md`，已完成的重构细节不长期保留在代办中。

## 安全建议

- 首次登录后立即修改默认管理员密码。
- 不要将管理面板直接暴露到公网；远程访问建议使用 HTTPS 反向代理。
- 项目会在管理员进入面板时提示 GitHub 新版本，但不会自动更新、重建或重启服务。

## 常见问题

**挂机需要一直打开网页吗？** 不需要。网页只是管理面板，关闭后容器仍会继续运行。

**重启机器后账号会自动挂机吗？** 容器会按 `restart: unless-stopped` 恢复，但账号默认不会自动启动。可在面板手动启动，或启用账号自动启动配置。

**微信账号为什么又要求扫码？** 新账号通常可以使用已保存凭证刷新 code。旧账号缺少 `wxid`、凭证失效或刷新失败时，需要重新扫码。

**为什么物品名称或图片缺失？** 资源随 Bot 版本发布。请先更新到最新版；仍有缺失时，可提交物品 ID 供维护者补充资源包。

**日志提示客户端版本过低怎么办？** 客户端日期和服务端版本前缀会自动校准。若持续失败，请更新 Bot 并重新构建镜像。

## 技术栈

- 后端：Node.js 20、TypeScript、Express、Socket.io
- 前端：Vue 3、Vite、TypeScript、Pinia、UnoCSS
- 工程：pnpm workspace、Docker Compose

## 特别感谢

- [XyhTender/qq-farm-automation-bot](https://github.com/XyhTender/qq-farm-automation-bot) — 本项目 fork 来源
- [Penty-d/qq-farm-bot-ui](https://github.com/Penty-d/qq-farm-bot-ui) — 上游二改基础
- [linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot) — 核心功能
- [QianChenJun/qq-farm-bot](https://github.com/QianChenJun/qq-farm-bot) — 部分功能
- [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot) — 赛季、活动协议与 ACE/TSDK 上报参考

## 免责声明

本项目仅供学习与研究。使用本工具可能违反游戏服务条款，由此产生的后果由使用者自行承担。请勿用于商业用途或倒卖。
