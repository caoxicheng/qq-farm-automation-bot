# 工程代办

- [ ] 补齐新网关协议的请求 `token` 并完成真实登录验证
  - 在 `gatepb.Message` 中增加 `string token = 3`
  - 为每个网关请求生成独立随机 token：64～127 位大小写字母或数字，末尾追加 `=`
  - 补充 token 格式、长度、随机性和封包字段测试
  - 重新构建 Docker 后使用测试账号扫码登录，持续观察至少 2 分钟
  - 验证背包、任务、农场、ACE、心跳和活动快照均能正常回包，且不再出现请求槽持续占用
  - 若仍然超时，再核对 TSDK 初始化凭证、`server_seq` 与心跳时序；不得记录二维码、Cookie、Code 或其他登录凭证

- [ ] 在网关协议稳定后拆分活动中心大模块
  - Core 将 `services/activity.js` 拆分为快照编排、活动领域服务、DTO 映射和状态持久化等单一职责模块
  - 保留统一活动门面和现有 Worker/HTTP 接口，避免改变协议路径与返回结构
  - Web 将 `stores/activity-center.ts` 中的类型、数据规范化、API 请求和各活动操作拆分，并保留轻量门面 Store
  - 将活动 Tab 元数据和共享类型移出 Store，使用注册表减少 `ActivityCenter.vue` 与 `BottomNav.vue` 的硬编码分支和层间耦合
  - 为快照 single-flight、操作后刷新、部分活动失败和不同账号隔离补充回归测试
  - 删除确认不再需要的旧后端兼容并行请求前，先核对版本兼容范围并记录弃用周期
  - 完成标准：功能和 HTTP DTO 保持兼容，Core/Web lint、测试和构建全部通过

- [ ] 删除 `scripts/sync-seed-assets.mjs` 兼容入口
  - 替代命令：`pnpm game-data sync`
  - 删除条件：新资源 CLI 随一个稳定版本发布，并完成下一稳定版发布准备
  - 删除时同步清理 README、package scripts、测试和弃用说明
