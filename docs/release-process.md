# Shadow Snap Release Process

Shadow Snap 使用本地 Release Controller，将代码集成、Release 选择、staged Production 和线上 Promote 分开。Vercel Git 自动部署对所有分支关闭；Git push 本身不会创建 Preview 或 Production deployment。

## 本地命令

```bash
# 只在 GitHub Actions 的只读 Admission job 中执行
npm run release:admit -- --tag v1.2.0 --hosted
npm run release:initialize -- --tag v1.2.0
npm run release:stage -- --tag v1.2.0
npm run release:promote -- --tag v1.2.0 --deployment https://deployment.vercel.app
npm run release:rollback -- --tag v1.2.0 --deployment https://previous.vercel.app
npm run release:resume -- --tag v1.2.0 --intent INTENT_SHA256
npm run release:recover -- --tag v1.2.1 --intent SUPERSEDED_EVIDENCE_SHA256
npm run release:renew -- --tag v1.2.0
npm run release:audit -- --local-only
npm run release:audit -- --tag v1.2.0
npm run release:unlock -- --tag v1.2.0
npm run release:fail -- --tag v1.2.0
npm run release:anchor-admission -- --tag v1.2.0 --asset-id ORIGINAL_GITHUB_ASSET_ID
```

普通本地调用 Admission 会被拒绝；本地门禁只能在已经核实 GitHub Billing/Spending Limit 导致托管 job 零步骤失败后，用 `--billing-fallback` 运行，并在 evidence 中明确标记。

除 Admission 和 Audit 外，第一次调用只输出包含准确 repository、tag、commit、artifact manifest、old ref/Current、Team、Project、rootDirectory、domains、Vercel CLI 版本、配置 hash、nonce 和过期时间的授权摘要。用户明确确认该摘要后，才可把对应 `authorizationDigest` 作为 `--authorize` 再调用。授权十分钟过期、只能消费一次，也不能跨仓、跨 tag、跨 deployment 或跨操作复用。

Controller 固定使用 Vercel CLI `50.28.0`。Admission 在准确 tag SHA 的临时 detached worktree 中运行，不能用当前 checkout 的代码替旧 tag 通过测试。Release evidence 同时保存完整 Git tree manifest，Stage 前会重新计算并逐项比对。

## 首次切换顺序

1. 合并包含 `git.deploymentEnabled=false` 和只读 workflow 的实现，验证该 commit 没有创建 Vercel deployment。
2. 在创建首个 tag 前，为 public repository 的 `production` 和 `v*` 建立 active rulesets。
3. 单独授权创建并推送准确 tag。tag 只运行 Admission，不发布 Release、不部署。
4. Review hosted artifact；若托管任务确认为 Billing/Spending Limit 零步骤，才可运行带证据的本地 fallback。fallback 必须绑定同一 SHA、workflow path、run attempt、job、check run 和 billing annotation；真实测试失败不能 fallback，也不能称为托管 CI 通过。
5. 单独授权发布 GitHub Release，并附加 hash 匹配的 `release-admission.json`。必须保留上传响应中的原始 GitHub asset ID，立即运行 `release:anchor-admission --asset-id <原始 ID>`；未完成原始 ID 锚定时，Initialize/Audit fail closed。
6. 单独授权 Initialize。它只创建 `production` ref，并确认没有 deployment。
7. 单独授权在 Vercel Dashboard 将 Production Branch 改为 `production`，并把 Auto-assign Custom Production Domains 设为关闭。线上 Current 必须保持不变。
8. 单独授权 Stage。Controller strict-fast-forward `production`，从准确 Release SHA 构建并运行 `vercel deploy --prebuilt --prod --skip-domain`。staged deployment 必须 READY、metadata 完整，并通过受保护 URL 的 HTTP 200 与页面标识检查。
9. 验收 staged URL 后，另行授权 Promote。Promote 前重读所有 ref、Release、evidence、Project、Current 和 deployment identity；Promote 后两个生产域名都必须通过 HTTPS 200 与页面标识检查，才写入 `production-acceptance`。

## Evidence 与恢复

本地 evidence 位于被忽略的 `.release-state/<tag>/`，权限限制为 `0700/0600`。指定 clone 必须保留所有历史 tag 的本地 evidence 和 `asset-ledger.json`；缺失 ledger 或任一 entry 时，远程 Audit 和历史 Rollback 会 fail closed，绝不会重新 TOFU。Admission 使用上传动作返回的原始 asset ID 首次锚定；Controller 自己上传 intent/completion 前先写 `upload-pending-*` journal，上传后立即写 ledger。若在两步之间崩溃，Resume 只接受名称、大小和 bytes SHA-256 都与 journal 唯一匹配的远端 asset，再补齐 ledger。GitHub Release 上每个 asset 使用唯一文件名；Controller 绝不使用 `--clobber`。Audit 会核对 asset ID、创建时间、大小和 SHA-256；任何变化都进入 drift freeze。

`npm run release:install` 将仓库绑定到当前真实 checkout、Git common dir 和主机级 registry，并自检普通 ref 放行、无 capability 的 `production` 推送拒绝。同一台主机上的第二个 clone 或 worktree 不能接管同一仓库。macOS registry 默认位于 `~/Library/Application Support/Shadow Release Controller/registry.json`，权限为 `0600`。

进程在 intent 后崩溃时，Resume 只能继续同一 intent：Initialize ref 已创建则只补 completion；Stage ref 已推进但没有 deployment 则继续同一 build/deploy；已有唯一匹配 deployment 则只补 completion；Promote/Rollback 已发生则核对 Current 和设置后补证据。多个 deployment 候选、目标变化或未知状态一律 freeze。

`initialized_expired` 和 `staged_expired` 不允许直接 Stage 或 Promote。`release:renew` 需要新的两步授权：initialized 只追加同一 tag/SHA 的续期 evidence；staged 还会重新检查同一 deployment 并再次运行 staged HTTP 验收，不能更换 deployment。若明确放弃过期 staged deployment，`release:fail` 通过独立授权写入 `stage_failed`。`stage_failed`、未完成的 `stage_intent` 或 `rolled_back` 则必须由一个新的已 Admission Release，用旧 Release 当前阻断 evidence 的准确 SHA-256 执行 Recover；Recover 只能解除一个明确阻断源。若进程崩溃留下过期本地 lease，`release:unlock` 先输出绑定 lease nonce/内容的授权摘要，确认后将原 lease 整体移动到 `stale-leases/` 留存，而不是删除取证。

## 限制

本地 hook、主机 registry 和单实例 binding 都不是服务器端 protected branch。Shadow Snap 的 GitHub rulesets 是额外防线；真正避免误推上线的是 Vercel 零自动部署、严格的本地双确认和 staged-before-Promote。`--no-verify`、其他主机、GitHub UI/API 和 Vercel Dashboard 管理员仍可绕过本地控制，因此每次远程 Audit 都会重新核对整个 release channel、refs、Release assets、Vercel Project、Current 和 deployment metadata。

Production Branch 只能通过 Vercel Dashboard 的受支持 Branch Tracking UI 修改；Controller 只读核对该设置，不调用未公开 API。Controller 不修改 DNS、环境变量、数据库或生产数据。Vercel CLI 未登录时，只能完成本地实现与本地合同测试，不能执行远程 Audit、Stage、Promote 或 Rollback。
