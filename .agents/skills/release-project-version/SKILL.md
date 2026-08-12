---
name: release-project-version
description: Safely prepare and publish versions of qq-farm-automation-bot. Use when the user asks to update or release a version, update CHANGELOG, create a release commit or Git tag, push a release to fork/main, or optionally rebuild Docker after publishing.
---

# 发布项目版本

安全发布 `qq-farm-automation-bot`。只操作当前仓库，并遵守仓库 `AGENTS.md` 的危险操作确认规则。

## 发布约束

- 使用 `core/package.json` 和 `web/package.json` 作为版本来源；两者必须始终一致。
- 包版本格式仅允许 `YYYYMMDD`、`YYYYMMDD-beta.N`、`YYYYMMDD-rc.N`；Git Tag 为包版本前加 `v`。
- 校验日期真实有效且 `N` 为十进制正整数。同日期按 `beta.N < rc.N < 正式版` 排序，不同日期以日期较新者为高版本。
- 新版本必须严格高于本地和 `fork` 远程的所有有效版本 Tag，且同名 Tag 在本地和远程均不存在。
- 固定发布到 `fork/main`。执行前确认 `fork` 的 fetch/push URL 指向 `caoxicheng/qq-farm-automation-bot`，当前分支为 `main`，并拉取远程 Tag 信息。条件不符时停止并报告，不擅自修改远程或切换分支。
- 不因发布流程或版本提醒功能修改 README。保留用户已有改动，禁止 reset、checkout、stash 或删除文件来清理工作区。
- 业务改动与版本发布改动使用两个独立提交。不得把未确认的文件加入任一提交。

## 1. 预检与版本确认

1. 读取 `git status --short`、当前分支、远程 URL、本地 Tag、`fork/main` 状态以及 `fork` 远程 Tag。
2. 读取两个 package 版本、CHANGELOG 顶部、从最新有效 Tag 到当前工作树的提交与差异。
3. 将未提交文件分成业务改动、发布文件和疑似无关改动，展示拟纳入范围。工作区不干净不是自动失败条件，但必须先获得用户对文件范围的明确确认。
4. 若用户未指定版本，根据上海时区当前日期和最高有效 Tag 提议一个版本：
   - 不自行决定正式版、RC 或 Beta；说明推荐值并等待明确确认。
   - 当当天正式版已存在时，不得用更高的同日预发布版本；提议下一有效日期或等待用户指定。
5. 在用户确认版本前，不修改任何文件。

## 2. 准备并验证业务改动

1. 根据已确认范围审阅业务差异。根据真实 diff 与最新 Tag 后的提交拟定 CHANGELOG 条目，不编造未实现内容。
2. 先运行与改动成比例的测试；本项目发布前至少运行：
   - `npm test` 与 `npm run lint`（`core/`）
   - `npm run lint` 与 `npm run build`（`web/`）
   - 仓库根目录 `git diff --check`
3. lint 会改写文件；运行前说明这一行为，并在运行后重新审计 diff。
4. 任一检查失败即停止，不得继续提交、Tag 或推送。构建产生的已忽略产物不得加入提交。
5. 展示业务提交的精确文件列表和 Conventional Commit 信息，并按 `AGENTS.md` 格式请求明确确认。确认后只暂存这些文件并创建业务提交。

## 3. 创建发布提交与 Tag

1. 同步更新两个 package 版本，并在 CHANGELOG 顶部新增 `## v版本（上海日期）` 条目；保留历史内容。
2. 重新校验两个版本一致、版本格式正确、CHANGELOG 标题与 Tag 一致，再运行必要测试与 `git diff --check`。
3. 展示仅包含 `core/package.json`、`web/package.json`、`CHANGELOG.md` 的发布提交范围；若存在其他文件则停止。
4. 单独请求确认后创建 `chore(release): v版本` 提交。
5. 确认发布提交为 HEAD、工作区没有意外改动且 Tag 仍不存在。单独请求确认后创建 annotated Tag：`git tag -a v版本 -m "v版本"`。

## 4. 推送与可选部署

1. 推送前展示将要发送的提交、目标 `fork/main` 和 Tag。分别请求明确确认：
   - 推送当前 `main` 到 `fork/main`。
   - 前一步成功后，推送唯一的 `v版本` Tag。
2. 任一步失败都停止，不重写历史、不 force push、不删除或移动 Tag。报告本地与远程状态以及安全恢复建议。
3. 两次推送成功后报告提交 SHA 与 Tag，并询问是否重新构建本地 Docker。
4. 仅在用户明确同意后执行项目现有 Docker Compose 构建和启动命令；完成后检查容器状态、健康状态和近期服务日志。部署失败不得回滚已发布 Git 历史，只报告故障。
5. 用户拒绝部署时，以分支和 Tag 均推送成功作为发布完成条件。

## 安全停止条件

遇到以下任一情况立即停止后续发布步骤：版本不一致或非法；新版本不高于已有版本；Tag 冲突；远程或分支不匹配；文件范围未确认；测试或构建失败；提交后出现意外改动；任何 Git 或 Docker 操作失败。不得用破坏性命令绕过问题。
