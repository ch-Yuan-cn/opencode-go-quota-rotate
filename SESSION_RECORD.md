# 会话交接记录：opencode-go-quota-rotate 插件开发

> 用途：上一工作空间会话的完整交接，供新工作空间直接续做。读完本文档即可开工。
> 项目路径：`/Volumes/Yuan SSD/yuan_works/opencode-go-quota-rotate`（本机 macOS）

## 一、项目目标

开发一个**开源**的 opencode 插件 `opencode-go-quota-rotate`，解决：

- opencode Go 付费订阅（provider `opencode-go`）多账号**额度感知轮转**：启动会话时查询各账号实时额度，选剩余最多的账号；
- 账号额度用尽（429 / rate-limit / insufficient balance 等）时**请求级自动切换**到下一个账号；
- 提供 CLI 查看各账号额度状态；
- 额度数据源与 `@slkiser/opencode-quota` 插件同源（同一 API），可与其共存。

## 二、为什么现成的 opencode-go-multi-auth 不满足需求（关键结论，全部实测验证）

### 1. 安装问题（已解决，方式可复用）
- 官方命令 `opencode plugin github:masrurimz/opencode-go-multi-auth --global` 失败（`git dep preparation failed` / 卡死）：仓库 **dist/ 未提交**（在 .gitignore 里）且**无 prepare 脚本**。
- 本机可用方案：克隆到本地 → `npm install` + `npx esbuild` 构建 dist → 在全局配置里用**本地绝对路径**引用插件。
- 已向作者提 issue：[masrurimz/opencode-go-multi-auth#1](https://github.com/masrurimz/opencode-go-multi-auth/issues/1)。

### 2. opencode 1.18.23 插件认证机制（反编译二进制确认 + 实测）
- 认证分发循环（简化）：`for (hook of hooks) { if (!hook.auth) continue; id = hook.auth.provider; if (already.has(id)) continue; if (!(await auth.get(id))) continue; result = await hook.auth.loader(...) }`
  - **门控 1**：auth.json 里必须已存在该 provider 条目，插件 loader 才会被调用（`auth.get(id)` 为空则跳过）。
  - **门控 2**：loader 返回的 `{ apiKey, fetch }`，**仅当 auth provider id 与请求的 provider 匹配时，opencode 才会使用返回的 fetch 包装器**。
- **go-multi-auth 失效根因**：它注册 `auth.provider = "opencode"`，但付费模型（`opencode-go/*`）请求走 auth provider `opencode-go`（auth.json 原生条目）→ 它的 loader/fetch 对付费请求**完全不被调用**（实测：fetch 插桩零调用），轮转和 429 切换全部无效。它的 loader 只在免费 zen 模型（provider `opencode`）请求时生效。
- **新插件必须注册 `provider: "opencode-go"`** —— 这是本项目最核心的设计决定。
- 已向 opencode 提 issue（loader 门控行为）：[anomalyco/opencode#45214](https://github.com/anomalyco/opencode/issues/45214)。

### 3. 额度 API（与 opencode-quota 同源，已实测可用）
- 端点：`GET https://opencode.ai/zen/go/v1/usage`
- 请求头：`Authorization: Bearer <apiKey>`、`Accept: application/json`
- 响应：`{ "usage": { "rolling": {status,percent,resetsAt}, "weekly": {...}, "monthly": {...} } }`
  - `percent` = 已用百分比（0-100）；`status` = `ok` | `rate-limited`；`resetsAt` = ISO 时间
- 实测当前额度：

| 账号 | rolling (5h) | weekly | monthly |
|---|---|---|---|
| 账号1 (`sk-LtMF2...`) | ok 14% | **rate-limited 100%**（已满，报 "Weekly usage limit reached"） | ok 77% |
| 账号2 (`sk-zq0jx...`) | ok 2% | **ok 1%** | ok 0% |

- 报错语义：`Weekly usage limit reached. Resets in 4 days` = 周额度用尽；`Insufficient balance ... /workspace/wrk_01M0EKXYCJP5WYDAC1BF59470S/billing` = 工作区余额不足（**可能两个 key 属于同一工作区，需充值**；新会话可向用户确认）。
- 注意：go-multi-auth 的切换只认 HTTP 429；额度类错误通常不是 429（402/403/4xx），新插件必须扩展检测（见 fetch.ts 设计）。

## 三、新插件设计（已确定，代码骨架已就位）

### 目录结构（GitHub 开源标准，已创建）
```
opencode-go-quota-rotate/
├── .github/workflows/ci.yml   # CI: npm install + typecheck + test + build
├── docs/architecture.md       # 架构文档（产品风格，已写）
├── src/
│   ├── index.ts               # 插件入口：auth hook provider="opencode-go"
│   ├── cli.ts                 # CLI: list/status/add/remove/quota
│   ├── storage.ts             # 账号存储（复用 opencode-go-accounts.json 格式）
│   ├── quota.ts               # 额度 API 查询
│   ├── rotate.ts              # 选号逻辑（周额度优先，round-robin 兜底）
│   ├── fetch.ts               # 请求级 failover fetch
│   ├── types.ts               # 类型定义（已写完整）
│   └── logger.ts              # 日志
├── test/                      # 测试占位
├── package.json / tsconfig.json / .gitignore / LICENSE / README.md
└── SESSION_RECORD.md          # 本文档
```

### 关键实现要点（写代码时对照）
1. **`auth.provider = "opencode-go"`**（不是 "opencode"）。
2. **loader 流程**：
   - `loadAccounts()`（读 `~/.config/opencode/opencode-go-accounts.json`，格式与 go-multi-auth 兼容，现有账号 1/2 直接可用）；
   - `pickAccount()`：对每个 enabled 账号查额度（缓存 5 分钟）→ 评分 `weekly.percent*10 + rolling.percent`，weekly 满（rate-limited 或 >=100）给 `1000+rolling` 惩罚 → 选最低分；平分时按轮转位置选下一个；全部查询失败则纯 round-robin；
   - `authClient.auth.set({ path: { id: "opencode-go" }, body: { type: "api", key } })`（保持 auth.json 条目新鲜）；
   - 返回 `{ apiKey: "", fetch }`（fetch 完全控制 Authorization 头，切换时改 header 即可）。
3. **fetch 包装器**：注入 `Authorization: Bearer <key>`；响应 429、或 402/403/409/5xx 且 body 匹配 `/(rate\s*limit|usage\s*limit|quota|insufficient\s+balance|balance|limit\s+reached|too\s+many\s+requests)/i` → 标记 exhausted → 换下一个账号重试；全部耗尽返回合成 429；**非错误响应不要消费 body**（clone 后再读）。
4. **auth.json 前提**：`~/.local/share/opencode/auth.json` 需有 `opencode-go` 条目（当前已有 = 账号2 key），否则 loader 不被调用。loader 每次运行会通过 auth.set 更新它。
5. **CLI 构建为 CJS**（`dist/cli.cjs`），插件入口构建为 ESM（`dist/index.js`），用 esbuild，无需 bun（本机无 bun）。

### 已就位的文件与状态
- 已写：`package.json`、`tsconfig.json`、`.gitignore`、`LICENSE`、`README.md`、`docs/architecture.md`、`.github/workflows/ci.yml`、`src/types.ts`（完整）、其余 `src/*.ts`（含 TODO 与设计注释的骨架）、`test/README.md`。
- **未写**：src 各模块的实现、测试用例。git 仓库尚未初始化（新会话可 `git init` + 首次提交）。

## 四、环境事实（本机现状）

- opencode CLI 1.18.23：`~/.local/bin/opencode`；桌面端 1.18.23：`/Applications/OpenCode.app`（常驻运行）。
- 全局配置：`~/.config/opencode/opencode.jsonc`（plugin 列表含 `/Users/ych/.config/opencode/plugins/opencode-go-multi-auth` 及其他插件；provider 声明 `opencode-go: {}`）。注意：**opencode.json 与 opencode.jsonc 并存时，plugin 数组是后写覆盖（mergeDeep），条目必须写在 jsonc 里**。
- auth.json：`~/.local/share/opencode/auth.json`，当前 `opencode-go`=账号2 key、`opencode`=账号1 key。
- 账号文件：`~/.config/opencode/opencode-go-accounts.json`（账号1 `sk-LtMF2vH...`、账号2 `sk-zq0jx...`，均有 enabled）。
- 现有 go-multi-auth 插件（本地安装、对付费请求无效）：`~/.config/opencode/plugins/opencode-go-multi-auth`（含已构建 dist 和 CLI `dist/cli.cjs`，可参考其 storage/logger/CLI 写法）。
- 工具：node 22（`/opt/homebrew/bin/node`）、npm 10.9.4、无 bun。esbuild 通过 `npx esbuild` 或项目 devDependency 使用。
- 本机 GitHub CLI 已认证（账号 `ch-Yuan-cn`，scopes 含 repo），发布/提 issue 可用 `gh`。

## 五、新会话 TODO（按顺序）

1. 实现 `src/` 各模块（storage → quota → rotate → fetch → index → cli → logger）。
2. 编写单元测试（quota 解析、选号评分、fetch failover 模拟；`node --test`）。
3. `npm install && npm run typecheck && npm test && npm run build`。
4. 安装到 opencode：把 `opencode.jsonc` 里 go-multi-auth 条目替换为本插件路径（`/Volumes/Yuan SSD/yuan_works/opencode-go-quota-rotate`），验证 `opencode debug config` 出现该插件。
5. 端到端验证：
   - `opencode run "hi" --model opencode-go/mimo-v2.5` → 查插件日志 `loader active`（应选账号2，因账号1 周额度已满）；
   - 插桩验证 fetch 被调用（在 fetch 里写日志文件）；
   - 额度切换：可临时把账号2 的 key 换掉/禁用模拟额度用尽，验证 failover。
6. git init + 首次提交；完善 README（安装/使用章节目前是 TBD）。
7. 开源发布准备（可选）：GitHub 仓库创建、README 徽章、发布 npm 等。

## 六、验证技巧（本次会话实测有效，省坑）

- **插件是否被加载**：在 `dist/index.js` 顶部注入写标记文件的代码（注意转义：用 node 生成 snippet 文件再拼接，不要在 heredoc/字符串里手写 \n）。
- **fetch 是否被 opencode 调用**：在 fetch 包装器里 `appendFileSync` 写日志（url + status）。
- **配置生效检查**：`opencode debug config`（看 plugin 列表）。
- 免费模型 `opencode/mimo-v2.5-free` 走 zen（provider `opencode`，插件 fetch 会被调用）；付费 `opencode-go/mimo-v2.5` 走 provider `opencode-go`。
- 桌面端/CLI 启动时读一次 auth.json，运行中不热更新；改 auth.json 后需重启相关进程。
