# 更新日志

本项目的版本号采用日期化规范（`vYYYYMMDD`），每次发布对应一个 tag。

## v20260812（2026-08-12）

### 新功能

- **微信登录凭证保活（loginBuffer 不再 1 小时失效）**：
  - loginBuffer 失效自动续期（refreshtoken 滚动刷新换新凭证，无需重新扫码）
  - 挂机账号每 30 分钟定时刷新凭证（长期挂机不掉线也持续续期，随时掉线秒连）
  - 账号持久化 refreshtoken（滚动续期总是更新，旧值不残留）
- **商店种植路径支持 2x2 主格**：非背包策略（商店购买）下 2x2 作物自动筛主格种植，无主格跳过不购买；失败学习与背包路径共享（2x2 配置缺失不再反复购买浪费金币）

### 修复

- refreshLoginBuffer 调用缺少 cookie jar 导致 TypeError（自动续期失效）——review 修复
- 账号更新接口允许 body 覆盖微信凭证（凭证覆盖防护）——review 修复
- 微信账号换绑 wxid 时旧凭证残留——review 修复
- 商店路径 2x2 金币不足时种子数未 clamp 主格数

## v20260811（2026-08-11）

### 新功能

- **微信登录原生化（进程内应用宝协议，不再依赖外部 yyb-go 服务）**：
  - `wx-login` 模块：微信 MMTLS 加密握手 + 开放平台扫码全流程（二维码生成/轮询/授权/换 code）
  - loginBuffer 登录凭证持久化到账号，自动重登/手动启动自动刷新 code（无需重新扫码）
  - 微信真实昵称 + 头像显示（应用宝用户信息接口；Dashboard 账号卡片新增头像）

### 修复

- MMTLS 握手加速：socket 超时 30s→5s、端口优先级排序（8080 优先）、尝试范围扩大——扫码/刷新 code 不再长时间 pending
- 登录 code 刷新失败限次 3 次停止（原无限 5s 重试循环），重试间隔拉长到 30s 降低风控触发
- 账号启动不再阻塞等待 code 刷新（fire-and-forget，启动响应 6s→13ms）
- 扫码轮询防请求堆积（长轮询串行化）+ 轮询/全局超时兜底（axios 10s→30s）
- OAuth code 重放防护（confirm 幂等）、账号创建防 loginBuffer 注入
- 微信头像 URL 白名单（仅 qlogo.cn 域名）防 SSRF

## v20260808（2026-08-08）

### 新功能

- **新野兽派 neo 主题**（参照 Vaultr DesignNeo.md 设计规范）：
  - 主题面板新增「野兽派」选项（白底 #fff / 黑字 #111 / 品牌黄 #eab308）
  - 全局 0 圆角 + 纯黑 2px 边框 + 硬阴影（2-4px 纯黑偏移，零模糊）
  - 品牌黄侧边栏 + active 深黄选中态（黑指示条）
  - 主操作按钮统一品牌黄 + 黑边框 + hover 按下位移
  - 登录页网格背景 + 白卡硬阴影；main 结构分割线 2px #333
  - **活动中心豁免**：星空独立设计不跟随主题（宽泛规则显式排除）

## v20260807（2026-08-07）

### 重构

- **移除重复的独立自动捣蛋实现**，复用好友巡查内置的「自动捣乱」（设置 → 好友互动 → `自动捣乱` 开关）：
  - 原独立实现（trick.js）与 friend.js 巡查逻辑重复（后者更完整：预检查可捣乱地块、远程剩余次数、Enter 上下文、限流处理）
  - 删除 trick.js 及 worker/store/设置面板的对应配置与开关
- **修复放虫/放草请求对齐线上格式**：`PutInsects/PutWeeds` 请求补 `field_4=2`（操作类型字段，抓包确认），确保巡查自动捣乱真正生效

## v20260806（2026-08-06）

### 新功能

- **神秘商人** — 限时 NPC 商品查询与购买：
  - 协议：`mysteryshoppb.MysteryShopService`（GetActiveNPC 查询 + Buy 购买，抓包反推验证）
  - 后端：`mystery-shop.js`（查询/购买/余额读取/商品名图）+ `/api/mystery-shop` 与 `/api/mystery-shop/buy`
  - 前端：侧边栏 🎩 独立页面（限时倒计时、商品卡片、数量选择、余额不足禁用）
- **抓包字段级验证工具** — `core/tools/decode-captures.js`：
  - 零硬编码类型映射（自动按 service/method 匹配请求/响应类型）
  - 请求明文/加密双通道解码 + roundtrip 重编码校验（字段级差异定位）
  - `--md` 输出字段级协议文档
- **协议字段补全** — 20 组协议 roundtrip 一致（请求帧 100%）：Login/GetSeasonInfo/Mall/Heartbeat/Harvest/Enter/Leave/PutInsects/PutWeeds 请求字段 + LandUpgradeCondition 价格/Buff/PlantInfo 等响应结构

### 其他

- README 更新（神秘商人/好友互动说明）
