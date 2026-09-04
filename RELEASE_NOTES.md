# Shadow Snap Release Notes

本文档记录 Shadow Snap（影瞬 · 电影感多行字幕长图生成工具）历史版本发布说明。

---

## v1.1.6 - 2026-09-05

> **类型**: 品牌实体关系与安全响应头增强

### 核心变更
- **可见语义**：主标题完整显示“影瞬 Shadow Snap”。
- **实体关系**：WebApplication JSON-LD 通过稳定 `@id` 关联 Shadow Nexus Organization。
- **安全响应头**：增加 `nosniff`、同源嵌入与 referrer policy，并纳入正式静态校验器。

---

## v1.1.5 - 2026-09-03

> **类型**: SEO/GEO 可发现性基础设施与受控发布对齐

### 核心变更
- **索引基础设施**：补充中文/英文标题、描述、canonical、Open Graph、Twitter 与 WebApplication JSON-LD。
- **爬虫入口**：新增 canonical `robots.txt` 与单 URL `sitemap.xml`。
- **发布验收对齐**：更新 Release Controller 的生产验收标题，并以回归测试锁定 SEO 合约。

---

## v1.1.4 - 2026-08-30

> **类型**: 发布治理与部署元数据加固

### 核心变更
- **元数据校验强化**：完善部署事实与受控 Promote 证据链比对，支持快照式验签。
- **发布状态收敛**：更新 `.release-state/v1.1.4` 生产状态，确保不可变归档。

---

## v1.1.3 - 2026-08-30

> **类型**: 意图门禁基线复核

### 核心变更
- **Pre-intent 证据链验证**：在生成阶段重检前置证据哈希，杜绝未经验证的脏构建进入待发布队列。

---

## v1.1.2 - 2026-08-30

> **类型**: 既有生产基线采纳 (Adopt Intent)

### 核心变更
- **支持既有基线纳入**：使受控发布流无缝对接历史已在生产环境稳定运行的静态 HTML/Canvas 部署。

---

## v1.1.1 - 2026-08-30

> **类型**: 规范化 Manifest 摘要

### 核心变更
- **文件指纹标准化**：规范化发布产物清单（Manifest）SHA256 计算逻辑，统一跨环境签名。

---

## v1.1.0 - 2026-08-30

> **类型**: 生产受控发布工作流与安全门禁

### 核心变更
- **接入 Release Controller**：引入受控发布流，拦截未登记 release 配置的直接 Tag 推送与旁路构建。
- **品牌矩阵与链接修正**：全站更新为「影瞬 Shadow Snap」，对齐单行极简 Footer 与 `snap.shadow.wang` 独立域名。
