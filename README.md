# 要求台账 / Directive Ledger

长对话里，用户明确提过的要求会被后续工具输出淹没，或者在新旧口径之间继续执行旧的那一个。这个插件把「用户明确提出的长期要求」做成一份**每一步都可见、可被新要求推翻、每条都能回溯到原话**的台账。

作用域是**当前会话**，不考虑跨对话记忆。

## 它解决什么

| 现象 | 机制 |
| --- | --- |
| 「我早就说过要用中文」 | 台账通过 `ctx.systemPrompt.context()` 进入每一步的运行时上下文，不依赖模型的检索意愿 |
| 「我已经改成方案 B 了」 | 同 `topicKey` 的新要求自动把旧的标为 `superseded`，常驻区只呈现生效中的那一条 |
| 「你嘴上答应，做出来的又是另一回事」 | `ban` + 可机器判定的检查器走 `ctx.tools.guard()`，同步、单调、任何监听都推翻不了 |

设计文档见 [`docs/design.md`](docs/design.md)。

## 使用

### 常驻块

每当台账非空，模型每一步都会看到：

```
仍然生效的用户要求（越新的条目会取代越旧的）：
- [BAN] 不要动 `D:\prod` 下的任何文件 (t14) [enforced]
- [RULE] 以后都用中文回答 (t2)
- [DEC] 算了，还是用 pnpm (t21)
```

`[enforced]` 表示这条可被工具守卫强制拦截。

### `/rule` 命令

不走模型，直接读写台账：

| 命令 | 作用 |
| --- | --- |
| `/rule list` | 按「生效中 / 已取代 / 已撤销 / 已失效」分组列出 |
| `/rule why <id>` | 说明这条从哪一轮来、推翻了谁、被谁推翻、是否可强制执行 |
| `/rule pin <id>` | 固定：保护它不被后续要求自动取代 |
| `/rule drop <id>` | 撤销：保留记录，但不再生效 |
| `/rule add <文本>` | 手动添加一条要求（按 `user-pinned` 记录） |

`<id>` 也可以写成来源事件序号，例如 `/rule why #7`。

### 输入区面板

会话输入框上方会显示当前生效的要求条数与其中可拦截的条数，展开后可见完整列表与已取代项。被预算挤掉的条目会标注「未注入」——面板不会声称模型看到了它其实没看到的东西。

## 什么会被识别

只有三类准入，宁可漏也不要污染：

1. **显式祈使**：`不要…` `必须…` `一律…` `以后…` `每次都…` `改成…`。
2. **字面锚定**：包含路径、命令、包名、语言名的短句。
3. **`/rule` 命令**。

以下**不会**被记录（真实 215 条消息的会话回放中逐条校准过）：

- 疑问句：`要不要改用 pnpm？`
- 叙述与自述：`我期望的是…`、`感觉也没啥意义…`
- 计划里的编号步骤：`2 大模型把列表做个初筛…`
- 条件句：`如果你认可我，就简化一下`
- 标记词出现在长句中段而非句首的散文

## 配置

```yaml
- id: directive-ledger
  name: '@local/dsh-directive-ledger'
  config:
    budgetTokens: 800       # 常驻块预算；超出的条目标注「未注入」而不是静默丢弃
    textLanguage: auto      # auto | zh | en
    reminderMode: 'off'     # off | auto | always（auto 仅在新要求推翻旧要求时提示）
    enforce: guard          # off | guard
```

## 设计约束

- **台账全部由会话日志派生**，插件不持有可写的业务状态；重启、恢复、压缩后折算出同一份台账。
- **折叠完整日志而非当前 surface**：压缩会重写 surface，从 surface 推导会让早期要求集体消失。
- **尊重历史改写**：`ask-again` 这类替换会通过 `sourceEventSeqs` 把对应条目置为 `retracted`，而不是让旧要求继续生效。
- **常驻块必须字节稳定**：内容不变的台账必须渲染出逐字节相同的文本，否则每一步都会写一条新的上下文快照并摧毁前缀缓存。
- **不新增会话事件类型**：那会让会话无法重开。`/rule` 的输入靠 `recordInput: true` 落在既有的 `command/run` 上。

## 测试

```powershell
npm test                                   # 全部单元与客户端冒烟测试
node test/replay-session.mjs <session.v4.jsonl.zstd>   # 用真实会话日志回放折叠结果
```

`replay-session.mjs` 是多帧 zstd 逐帧解压后折叠的，用来对真实对话测量召回与误报——本项目主要的三轮精度修复都由它发现。

## 安装

包名 `@local/dsh-directive-ledger`，Loader 行 `directive-ledger`，Git 仓库 `plugins/dsh-directive-ledger`。安装使用 `plugin_manager` 的 `install_bundle`，不直接编辑 profile。
