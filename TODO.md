# 工程代办

## 已完成

- [x] 补齐新网关协议请求 `token`，并通过 Docker 真实账号验证核心链路。
- [x] Core 后端迁移到 TypeScript，完成活动中心拆分及测试、构建、Docker、`pkg` 验收。

## 待办

- [ ] 删除 `scripts/sync-seed-assets.mjs` 兼容入口
  - 替代命令：`pnpm game-data sync`
  - 删除条件：新资源 CLI 随一个稳定版本发布，并完成下一稳定版发布准备
  - 删除时同步清理 README、package scripts、测试和弃用说明
