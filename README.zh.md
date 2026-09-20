---
description: "拒绝 shell 手工改文件的 fork 本地守卫：让模型改用 write/edit 工具，从而保留文件系统版本守卫与先读后写策略"
kind: "package-reference"
---

# dsh-shell-edit-guard

[English](README.md) | 中文

## 摘要

这个 fork 本地插件拒绝"用 shell 手工改文件"这类命令——`sed -i`、`perl -pi`、内联 `python`/`node` 脚本、heredoc、重定向、`tee`、`patch`、`dd of=`、`truncate` 以及对应的 PowerShell 写法——并明确告诉模型改用 `write`/`edit` 工具。这两个工具受文件系统版本守卫与先读后写策略保护；shell 编辑同时绕过两者，也不留下可审查的 diff，因此上下文一长就容易在毫无保护的情况下把文件改坏。

它注册在 `ctx.tools.guard` 上，该守卫在可扩展的 `tools/pre-execute` 瀑布之后运行：任何守卫都可以拒绝调用，而没有任何插件能强制放行已被本守卫拒绝的调用。当该 agent 没有可用的 `write`/`edit` 工具时，守卫不做任何拦截，精简组合仍可正常使用 shell。

`plugins/` 下的包永不发布：本 manifest 标记为 `private`，代码放在这里而不是 `packages/`——后者是仓库留给 release member 的位置。

## 目录

- [使用](#use-this-plugin)
- [规则](#rules)
- [配置](#configuration)
- [验证](#verification)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-plugin"></a>
## 使用

profile 消费 `plugins/` 下的包，与消费任何外部插件的方式相同：装进 profile，之后让该行保持挂载。

```sh
cd /path/to/deepseek-harness
pnpm run build
pnpm dsh plugin --profile web add file:$PWD/plugins/dsh-shell-edit-guard
```

安装会把该插件记入 profile 的 `package.json`，并把 `dsh-shell-edit-guard` 加入 `dsh.profile.bundles`，其 `cordis.patch.yml` 负责插入这一行。之后重启 `dsh web`：插件模块在启动时加载一次，运行中的 host 会一直使用启动时的那份代码。

不安装也可以：把同一行写进 patch 文件旁边（相对 `name` 按 patch 文件所在目录解析）。

```yaml
- insert:
    - id: shell-edit-guard
      name: './index.js'
```

<a id="rules"></a>
## 规则

| rule | 命中的写法 |
|---|---|
| `sed-in-place` | `sed -i`、`sed --in-place`、`gsed -i`，含 `find … -exec sed -i` |
| `perl-in-place` | `perl -pi`、`perl -i` |
| `inline-interpreter` | `python -c` / `python <<EOF` / `node -e` / `ruby -e` / `php -r` 且命令中出现写操作 |
| `redirect` | `>` / `>>` 写入非临时文件，含 heredoc 正文 |
| `tee` | `tee <文件>`、`tee -a <文件>` |
| `patch` | `patch -p1 < x.diff`、`git apply x.patch` |
| `dd` | `dd of=<文件>` |
| `truncate` | `truncate -s …` |
| `powershell-write` | `Set-Content`、`Add-Content`、`Out-File`、`Clear-Content`、`Export-Csv`、`New-Item`、`[IO.File]::WriteAllText` |
| `extra` | 部署方自定义的 `extraPatterns` |

只写临时路径的命令（`/tmp/`、`$TMPDIR`、`mktemp`、`/dev/null`、`/dev/fd/*`、`/var/folders/`）照常放行；只读用法（`sed -n`、`perl -ne`、仅读取的 `node -e`）、项目工具链（`pnpm`/`npm`/`yarn`、构建、测试、formatter、`python3 scripts/gen.py`）以及 git 工作流同样放行。

判定只读命令文本，从不检查解释器所运行的脚本文件内容。因此项目自带的 formatter、代码生成器或构建命令照常工作，只有"把 shell 当编辑器用"才被拒绝。

<a id="configuration"></a>
## 配置

行配置字段在加载时校验——写错规则 id 或写出非法正则会当场报错，而不会静默少拦：

| 字段 | 默认 | 说明 |
|---|---|---|
| `tools` | `['bash', 'pwsh']` | 要检查的命令类工具 |
| `disabledRules` | `[]` | 关闭的内置规则 id；未知 id 在加载时报错 |
| `allowPatterns` | `[]` | 放行正则；命中的简单命令直接放行 |
| `extraPatterns` | `[]` | 追加拦截正则；命中的简单命令直接拒绝 |
| `requireEditorTool` | `true` | 仅当该 agent 可见 `write` 或 `edit` 时才拦截 |

两个正则列表都按"单条简单命令"逐段匹配，因此 `allowPatterns: ['^git apply ']` 不会豁免挂在 `git apply` 后面的 `sed -i`。

<a id="verification"></a>
## 验证

```sh
pnpm exec vitest run plugins/dsh-shell-edit-guard
```

测试覆盖每条规则、临时路径豁免、两个正则列表、规则禁用分支、配置错误、守卫卸载，以及一个经 Loader 启动的 `cordis.yml` 组合。`pnpm run test:coverage` 对 `plugins/*/src` 采用与 `packages/*/*/src` 相同的 per-file 100% 门槛。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **`tee` 写日志也会被拦。** 规则判断的是写入目标而非意图；`… | tee build.log` 需要 `disabledRules: ['tee']` 或改写到 `/tmp`。
- **`patch` 与 `git apply` 默认被拦** —— 它们本身就是"写文件的补丁应用"。确有需要时用 `allowPatterns` 放行。
- **临时路径豁免是启发式。** 它按命令里出现的路径判断；同时写临时文件和源码文件的命令，按源码文件处理。
- **只看命令文本。** 若 shell 命令转交给守卫看不见的编辑器进程（例如 `my-editor --write src/file.ts` 且 `my-editor` 是项目脚本），该命令会放行。
