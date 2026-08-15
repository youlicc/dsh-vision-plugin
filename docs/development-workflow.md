# 开发工作流：feature 分支 + PR + squash merge

本仓库（master 受 GitHub ruleset 保护：强制 PR、禁 force push、禁删除）。日常开发走 **feature 分支 → PR → squash merge**；admin 保留 bypass 权限，仅用于紧急热修。

## 核心规则

1. **master 不直接开发**：每个功能/修复在独立分支上开发。
2. **每个 feature 一个 PR**：PR 合入 master 前经 GitHub 的 pull_request 规则校验（无需审批人，规则仅保证走 PR 通道）。
3. **squash merge**：合并时把 feature 分支的全部 commit 压缩为一个（合并设置允许 merge/squash/rebase，统一用 squash 保持 master 线性历史）。
4. **分支命名**：`feat/<描述>`、`fix/<描述>`、`chore/<描述>`、`docs/<描述>`。

## 流程（每个 feature）

### 1. 从最新 master 切分支

```sh
git checkout master
git pull origin master            # 确保基线最新
git checkout -b feat/my-feature   # 或 fix/xxx / chore/xxx
```

### 2. 开发 + 本地提交

```sh
# 开发中可多次提交，反复修改无所谓——合并时会压缩
git add -A
git commit -m "feat: 描述这次改动"
```

### 3. 推送分支 + 开 PR

```sh
git push -u origin feat/my-feature
gh pr create --base master --head feat/my-feature --title "feat: ..." --body "..."
```

### 4. squash 合入

```sh
# 合入（squash），并删除远程分支
gh pr merge --squash --delete-branch
```

### 5. 本地同步 + 清理

```sh
git checkout master
git pull origin master            # 拉到 squash 后的单个 commit
git branch -d feat/my-feature     # 删除本地分支
```

## 本地开发分支的 commit 卫生

feature 分支上的**中间 commit 不需要整洁**——squash 会把它们压成一个。但保持以下习惯：

- **提交信息写清楚**（哪怕只给 squash 提供素材）；
- **不要在本地反复 rebase/整理中间 commit**（squash 时代这是浪费）；
- 若一个 PR 里有多条独立逻辑，可拆多个 PR，不要靠 commit 划分。

## 紧急热修（admin bypass）

```sh
# 仅限生产事故等紧急情况：直接修 master（绕过 PR）
git checkout master && git pull
git commit -am "fix: 紧急热修"
git push origin master
```

推送时 GitHub 会提示 "Bypassed rule violations"——这是预期的（admin bypass），不代表失败。

## 本仓库特例

- **构建产物 `lib/` 入库**：改源码后需重新 `tsdown` 构建并提交 lib/（运行时加载的就是它）。
- **`pnpm-lock.yaml` 入库**：改依赖后 pnpm install 会更新它，随 PR 一起提交。
- **测试**：合并前跑 `vitest run` + `tsc --noEmit` 全绿（61 用例 + 1 跳过）。

## 相关

- ruleset：`main`（PR-only + 禁 force push + 禁删除；admin bypass always）
- 复盘方法论：见 `plugin-engineering-retrospective.md`
