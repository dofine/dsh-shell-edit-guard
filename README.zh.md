---
description: "拒绝 shell 手工改文件的守卫：壳语法感知的规则 + Jev（System One）判定，让模型改用 write/edit 工具，从而保留文件系统版本守卫与先读后写策略"
kind: "package-reference"
---

# dsh-shell-edit-guard

[English](README.md) | 中文

## 摘要

这个插件拒绝"用 shell 手工改文件"这类命令——`sed -i`、`perl -pi`、内联 `python`/`node` 脚本、heredoc、重定向、`tee`、`patch`、用 `sh -c`/`bash -c` 再套一层编辑器，以及对应的 PowerShell 写法——并明确告诉模型改用 `write`/`edit` 工具。这两个工具受文件系统版本守卫与先读后写策略保护；shell 编辑同时绕过两者，也不留下可审查的 diff，因此上下文一长就容易在毫无保护的情况下把文件改坏。

判定分两层。规则按 shell 的读法解析命令——**引号里的是数据而不是语法**，所以 SQL 字符串里的 `>` 比较不是重定向——清楚的情况零成本解决。当语法本身分不清"查询"与"手工修改"时，插件调用已挂载的 [`dsh-jev-decide`](https://github.com/deepseek-ai/deepseek-harness/discussions/7315) 工具，拿到校准过的 Noul 概率后按阈值判定。judge 是可选的：没有它、调用失败、超时，或概率落在中间带时，一律沿用规则结论。

拒绝动作来自 `ctx.tools.guard`，它在可扩展的 `tools/pre-execute` 瀑布之后运行：任何守卫都可以拒绝调用，而没有任何插件能强制放行已被本守卫拒绝的调用。当该 agent 没有可用的 `write`/`edit` 工具时，守卫不做任何拦截，精简组合仍可正常使用 shell。

本 manifest 标记为 `private`，不会发布到 npm：profile 直接从本仓库的 Git 地址安装，安装过程中由 `prepare` 构建出 `lib/`。

## 目录

- [使用](#use-this-plugin)
- [规则](#rules)
- [judge（Jev 判定）](#the-judge)
- [配置](#configuration)
- [验证](#verification)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-plugin"></a>
## 使用

profile 消费本插件，与消费任何外部插件的方式相同：装进 profile，之后让该行保持挂载。

```sh
pnpm dsh plugin --profile web add github:dofine/dsh-shell-edit-guard
```

安装过程由 `prepare` 用 `tsc` 编译出 `lib/`，无需额外的构建步骤。

要直接改代码，则改用链接方式安装本地检出：

```sh
git clone https://github.com/dofine/dsh-shell-edit-guard
pnpm dsh plugin --profile web add link:$PWD/dsh-shell-edit-guard
```

用 `link:` 而不是 `file:`：`file:` 会把包**拷贝**进 profile 的 `node_modules`，之后再构建也到不了 profile；`link:` 始终指向该目录。用链接后，改代码只需 `pnpm run build` + 重启。

安装会把该插件记入 profile 的 `package.json`，并把 `dsh-shell-edit-guard` 加入 `dsh.profile.bundles`，其 `cordis.patch.yml` 负责插入这一行。之后重启 `dsh web`：插件模块在启动时加载一次，运行中的 host 会一直使用启动时的那份代码。

要让守卫拿到 judge，再安装并挂载该工具：

```sh
pnpm dsh plugin --profile web add dsh-jev-decide
```

`dsh-jev-decide` 不带 bundle，需要在 profile 的 `cordis.patch.yml` 里补一行：

```yaml
- insert:
    - id: dsh-jev-decide
      name: dsh-jev-decide
```

<a id="rules"></a>
## 规则

| rule | 命中的写法 |
|---|---|
| `sed-in-place` | `sed -i`、`sed --in-place`、`gsed -i`，含 `find … -exec sed -i` |
| `perl-in-place` | `perl -pi`、`perl -i` |
| `inline-interpreter` | `python -c` / `python <<EOF` / `node -e` / `ruby -e` / `php -r` 且命令中出现写操作 |
| `shell-inline` | `sh -c "…"` / `bash -c "…"`，其载荷命中上述任一写法 |
| `redirect` | `>` / `>>` 写入非临时文件；按 shell 的读法解析（引号里的目标算文件，引号里的 `>` 不算重定向；`2>` / `2>>` 写的是 stderr，属于捕获输出而不是写入模型指定的文本） |
| `tee` | `tee <文件>`、`tee -a <文件>` |
| `patch` | `patch -p1 < x.diff`、`git apply x.patch` |
| `dd` | `dd of=<文件>` |
| `truncate` | `truncate -s …` |
| `powershell-write` | `Set-Content`、`Add-Content`、`Out-File`、`Clear-Content`、`Export-Csv`、`New-Item`、`[IO.File]::WriteAllText` |
| `extra` | 部署方自定义的 `extraPatterns` |

只写临时路径的命令（`/tmp/`、`$TMPDIR`、`mktemp`、`/dev/null`、`/dev/fd/*`、`/var/folders/`，以及仓库内约定为临时或输出的目录如 `tmp/`、`.tmp/`、`logs/`）照常放行，把命令的 stderr 捕获到任意路径（`… 2>logs/run.log`）同样放行；只读用法（`sed -n`、`perl -ne`、仅读取的 `node -e`）、项目工具链（`pnpm`/`npm`/`yarn`、构建、测试、formatter、`python3 scripts/gen.py`）、git 工作流，以及打印结果的查询（例如 `psql -c "SELECT … WHERE dt >= '20260901'"`——比较运算符在引号内，shell 不会当成重定向）同样放行。

<a id="the-judge"></a>
## judge（Jev 判定）

命令命中规则时，守卫通过 `jev_decide` 工具问一个 Noul 问题——这是手工改文件，还是仅仅读取/输出？端点、凭证、重试与错误映射都由该工具负责；本插件只负责问题、阈值与回落策略。

| 概率 | 结论 | 行为 |
|---|---|---|
| ≥ `denyAt`（0.8） | `edit` | 拒绝，拒绝原因里带上模型名与概率 |
| ≤ `allowAt`（0.2） | `read-only` | 放行，覆盖原先命中的规则 |
| 中间带 | `unsure` | 走 `onUnsure`，默认沿用规则结论；若部署方更愿意放过误报，设为 `allow`，这样连规则分不清是编辑还是输出的 stdout 捕获也会放行 |

judge 挂在 `tools/pre-execute`（唯一能容纳异步判定的位置），再把结果按调用交给同步的 `ctx.tools.guard`。结论按命令文本缓存，同一条命令只花一次调用。judge 工具自身永不被检查，因此守卫不会递归进自己的 judge。

凭证：环境变量 `TYPESAFE_API_KEY`，或 `~/.dsh/.credentials.yaml` 的 `refs.TYPESAFE_AI_API_KEY`——两者都由 `dsh-jev-decide` 读取，不由本插件读取。都没有时 judge 不可用，只有规则生效。

<a id="configuration"></a>
## 配置

行配置字段在加载时校验——写错规则 id、非法正则、阈值反序或空问题都会当场报错，而不会静默少拦：

| 字段 | 默认 | 说明 |
|---|---|---|
| `tools` | `['bash', 'pwsh']` | 要检查的命令类工具 |
| `disabledRules` | `[]` | 关闭的内置规则 id；未知 id 在加载时报错 |
| `allowPatterns` | `[]` | 放行正则；命中的简单命令直接放行 |
| `extraPatterns` | `[]` | 追加拦截正则；命中的简单命令直接拒绝 |
| `requireEditorTool` | `true` | 仅当该 agent 可见 `write` 或 `edit` 时才拦截 |
| `judge.enabled` | `true` | 是否调用 judge 工具 |
| `judge.tool` | `jev_decide` | 返回校准概率的工具名 |
| `judge.question` | 见上文的策略问题 | 对每条命中命令提出的是/否问题 |
| `judge.model` | 用工具自身默认 | 透传给 judge 工具的模型 id |
| `judge.denyAt` / `judge.allowAt` | `0.8` / `0.2` | 编辑与只读两侧阈值 |
| `judge.timeoutMs` | `2000` | 单次 judge 调用的上限 |
| `judge.cacheSize` | `200` | 结论缓存的命令条数 |
| `judge.mode` | `flagged` | 只对规则命中的命令判定，或对每条命令判定（`always`） |
| `judge.onError` | `rules` | judge 不可用时：沿用规则结论，或 `allow` |
| `judge.onUnsure` | `rules` | 中间带：`rules`、`allow` 或 `deny` |

两个正则列表都按"单条简单命令"逐段匹配，因此 `allowPatterns: ['^git apply ']` 不会豁免挂在 `git apply` 后面的 `sed -i`。

<a id="verification"></a>
## 验证

```sh
pnpm test
```

测试覆盖每条规则、壳语法读取器（引号跨度、重定向目标、赋值）、临时路径豁免、两个正则列表、规则禁用分支、judge 阈值与缓存、对已注册 `jev_decide` fixture 的接线（放行、拒绝、失败、超时、中间带、缓存、`always` 模式、递归防护）、配置错误、守卫卸载，以及一个经 Loader 启动的 `cordis.yml` 组合。`pnpm test` 会先构建 `lib/`，因为插件级测试按包名导入本包。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **`tee` 写日志也会被拦。** 规则判断的是写入目标而非意图；`… | tee build.log` 需要 `disabledRules: ['tee']` 或改写到 `/tmp`。
- **`patch` 与 `git apply` 默认被拦** —— 它们本身就是"写文件的补丁应用"。确有需要时用 `allowPatterns` 放行。
- **临时路径豁免是启发式。** 它按命令里出现的路径判断；同时写临时文件和源码文件的命令，按源码文件处理。
- **只看命令文本。** 若命令转交给守卫看不见的编辑器（例如 `my-editor --write src/file.ts`，且 `my-editor` 是项目脚本），默认会放行；`judge.mode: always` 时才由 judge 兜住。
- **judge 会给每条命中命令加一次调用**，其延迟在关键路径上；清楚的情况由规则直接裁决，judge 不可用时也始终回落规则。
