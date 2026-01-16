---
name: git-bump
description: 一键版本升级并 git 提交
category: Release
tags: [version, git, release]
---

**一键版本升级**

自动递增 patch 版本并提交。

**立即执行以下操作，无需确认**:

1. 读取 `package.json` 中的 `version` 字段
2. 递增 patch 版本 (例: 1.20.0 → 1.20.1)
3. 使用 Edit 工具更新 `package.json`
4. 执行: `git add -A && git commit -m "chore: bump version to <新版本>"`
5. 创建 tag: `git tag v<新版本>`
6. 输出: `✓ 版本升级完成: <旧版本> → <新版本>，本地 tag v<新版本> 已创建`
