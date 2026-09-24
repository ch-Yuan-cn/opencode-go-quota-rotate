# opencode-go-quota-rotate（Go 订阅多账号额度轮换插件）

> 🌐 [English README](README.md) ｜ 中文版

[![CI](https://github.com/ch-Yuan-cn/opencode-go-quota-rotate/actions/workflows/ci.yml/badge.svg)](https://github.com/ch-Yuan-cn/opencode-go-quota-rotate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 这个插件是干什么的？

OpenCode 的 **Go 付费订阅**（比如 `opencode-go/mimo-v2.5` 这类模型）是按**每个 API Key** 限制额度的：滚动额度（约 5 小时）、周额度、月额度，哪个窗口用满就哪个报错。

如果你有好几个 Go 的 API Key，可能会出现这种情况：

- 账号 1 的周额度用满了，报 `Weekly usage limit reached`，但账号 2 的周额度还是 1%；
- 你想继续用，只能手动换 key、或者等下周。

这个插件就是帮你**自动搞定这件事**：

1. **开会话时自动挑额度最多的账号**——启动时逐个查每个 key 的实时额度，选剩余最多、最不容易用完的那个；
2. **用着用着额度用尽了自动切换**——当前账号返回 429（限流）或「余额不足 / 额度用尽」之类的错误时，同一个请求自动改用下一个账号重试，不用你手动干预；
3. **命令行随时查额度**——想知道每个账号还剩多少，一条命令搞定。

## 特点

- **额度感知选号**：综合滚动 / 周 / 月三个额度的实时使用率评分，优先选最空的账号；
- **自动切换（failover）**：请求级检测 429、限流、额度/余额不足等错误，自动换下一个账号重试；
- **账号隔离**：一个 OpenCode 进程固定用一个账号，不互相干扰；
- **状态持久化**：账号列表、轮换位置重启后都还在；
- **无需改 OpenCode 本体**：以插件形式安装；
- **与 `@slkiser/opencode-quota` 插件共存**：两者用同一个额度接口，互不冲突。

## 环境要求

- OpenCode 1.18.x（需要 Go 订阅）
- Node.js 18+（构建插件和运行 CLI 用）

## 安装

### 第 1 步：构建插件

```sh
git clone https://github.com/ch-Yuan-cn/opencode-go-quota-rotate.git
cd opencode-go-quota-rotate
npm install
npm run build   # 生成 dist/index.js（插件本体）和 dist/cli.cjs（命令行工具）
```

### 第 2 步：告诉 OpenCode 加载这个插件

编辑全局配置文件 `~/.config/opencode/opencode.jsonc`，在 `plugin` 数组里加上项目的**绝对路径**：

```jsonc
{
  "plugin": [
    "/你的绝对路径/opencode-go-quota-rotate"
  ]
}
```

重启 OpenCode（CLI 和桌面端都要），然后确认插件已被识别：

```sh
opencode debug config   # 输出的 plugin 列表里应能看到这个插件的路径
```

### 第 3 步：一个必须的前置条件

OpenCode 1.18.x 有一个坑：**auth.json 里必须已经存在 `opencode-go` 这条记录**，插件的选号逻辑才会被调用（这是 OpenCode 的认证门控机制）。

检查 `~/.local/share/opencode/auth.json` 里有没有 `opencode-go` 条目；没有的话先随便用某个 Go key 登录一次（比如 `opencode auth login`）。插件每次开会话会自动把这条记录更新成当前选中的 key。

## 使用方法

插件要求至少有一个**启用**的账号。添加账号有两种方式：

- **命令行**（见下）；
- **OpenCode 内置登录**：在输入框执行 `/login`，选 **Add Go Account**，按提示粘贴 key。

### 命令行工具

```sh
# 在插件目录下运行（或全局安装 `npm i -g .` 后用 opencode-go-quota-rotate 命令）
node dist/cli.cjs add -k sk-xxxx -l "账号1"   # 添加账号，-l 是可选备注名
node dist/cli.cjs list                        # 列出所有账号（标出当前使用的）
node dist/cli.cjs status                      # 查看轮换位置
node dist/cli.cjs remove 2                    # 按编号删除账号（从 1 开始数）
node dist/cli.cjs quota                       # 查看每个账号的实时额度
```

### 查看额度示例

```
账号1 sk-LtMF...MpBC
  rolling: 14% ok (resets 2026-08-26T11:10:18.330Z)
  weekly: 100% rate-limited (resets 2026-08-31T00:00:00.330Z)
  monthly: 77% ok (resets 2026-09-20T03:42:10.330Z)
账号2 sk-zq0j...pAqm
  rolling: 2% ok (resets 2026-08-26T14:41:01.115Z)
  weekly: 1% ok (resets 2026-08-31T00:00:00.115Z)
  monthly: 0% ok (resets 2026-09-25T06:29:26.115Z)
```

字段说明：`rolling` = 滚动额度（约 5 小时窗口）、`weekly` = 周额度、`monthly` = 月额度；百分比是**已使用**的比例（越大越危险），`rate-limited` 表示这个窗口已经用满被限流了；`resets` 是额度重置时间。

## 它是怎么选账号的？

每次开会话，插件都会调用 OpenCode Go 的额度接口（`GET https://opencode.ai/zen/go/v1/usage`，和 `@slkiser/opencode-quota` 用的是同一个接口）查每个启用 key 的实时额度，然后分两步选号：

1. **先筛掉现在用不了的账号**：任何一个窗口已经用满（`rate-limited` 或已用 100%）的账号，只有在一个能用的账号都没有时才会被选中。
2. **优先用「额度快作废」的账号**：额度只有在重置前花掉才算数，所以剩余额度越接近重置的账号越优先：

   ```
   流失风险 = 剩余额度% ÷ 距重置小时数
   ```

   风险最高的赢。风险相同（或所有账号都读不到重置时间）时，退回按**额度占比**排序：`周额度已用% × 10 + 滚动额度已用%`，越低越优先，再同分则按轮换顺序。用满的窗口罚分为 2000（滚动）/ 3000（周）/ 4000（月）+ 滚动已用%，都高于任何健康分数的上限，所以用满的账号永远不会盖过能用的账号。

只有**配额窗口**参与"流失风险"的计算：滚动窗口是限速（≈5 小时，而且不管用不用都一直向前滑），它的剩余额度永远不会"作废"。周与月这两个窗口里，只有**各账号重置时间不同**的那个才有区分意义——共同的重置边界意味着"不管花哪个账号，没用的额度都在同一瞬间一起作废"，它无法让某个账号更紧急。实测（2026-09-24）：周额度是共同的日历边界（所有账号都是周一 00:00 UTC），月额度按各账号自己的订阅日，所以实际起作用的是月额度。

**额度接口对每个账号都连不上**（断网等）时退化为纯轮换，不影响使用。

### 会话中途额度用尽怎么办？

如果当前账号在请求过程中返回了以下错误，插件会把该账号标记为**已耗尽**，并自动用下一个账号**重试同一个请求**：

- HTTP 429（限流）；
- HTTP 401（key 被吊销/无效）；
- HTTP 402 / 403 / 409 / 5xx，且错误信息里出现额度 / 限流 / 余额不足等字样（比如 `rate limit`、`quota`、`insufficient balance`）。

所有账号都用尽时，会返回一个合成的 429 响应，并记录日志。

## 文件说明

| 文件 | 作用 |
|---|---|
| `~/.config/opencode/opencode-go-accounts.json` | 账号列表（key、备注、启用状态） |
| `~/.config/opencode/opencode-go-quota-rotation.json` | 最近使用的账号位置 |
| `~/.config/opencode/opencode-go-quota-rotate.log` | 插件运行日志（选号结果、切换记录等） |

## 排错

- **插件似乎没生效**：先 `opencode debug config` 确认插件路径在列表里；再确认 auth.json 有 `opencode-go` 条目；最后看日志文件里有没有 `loader active` 记录。
- **想看插件到底做了啥**：打开 `~/.config/opencode/opencode-go-quota-rotate.log`，里面记录了选号（`loader active`）、请求（`fetch call`）、切换（`failover`）等事件。
- **改了账号文件不生效**：OpenCode 只在启动时读一次认证信息，改完需要重启相关进程。

## 许可证

MIT
