# 装配表规范（AssemblyTable/1）

> 一份表描述"一次装配要装哪些内容块、各放哪条通道、按什么顺序、多少字"。
> 装配器只照表执行；改内容改表，不改代码。实现见 `engine/assembly/`。

## 一、顶层

```jsonc
{
  "schema": "AssemblyTable/1",
  "version": 1,
  "id": "play-example",
  "channels": { "card": "tool", "slices": "tool", "allowCardInUser": false,
                "memory": "user", "instruction": "user", "sliceMax": 4 },
  "layout":   { /* 固定字面量，一处定义多处引用 */ },
  "sources":  { /* 具名内容源：file | template */ },
  "documents":{ "inputMd": {...}, "taskText": {...} },
  "sections": [ /* 节清单 */ ]
}
```

| 键 | 作用 |
|---|---|
| `channels` | **通道判定本身**。`card/slices/memory/instruction` 各属哪条通道写在这里，装配器不猜 |
| `layout` | 固定字面量：文档头/尾、切片标题、记忆层标题、注入块标记 |
| `sources` | 具名源。`file` 给路径（相对装配器目录）；`template` 支持 `{{INPUT_MD}}` `{{OUT_DIR}}` `{{JOB_DIR}}` |
| `documents` | 每份产物一个条目：`order`（节 id 顺序）+ `join`（节间分隔符） |
| `sections` | 见第二节 |

## 二、节

```jsonc
{
  "id": "sceneUser",
  "order": 40,
  "doc": "inputMd",
  "channel": "tool",
  "shape": "block",
  "heading": "## [★ 当前场景 · 玩家这一句（正文从这里接着写）]",
  "body": { "from": "msg", "select": "last", "role": "user", "tail": 1200 },
  "when": { "fact": "hasLastUser", "eq": true },
  "note": "取未切注入块的原文末 1200 字；与 floors 是同一条消息的两个视图"
}
```

### 2.1 `shape`：字节级拼法

| shape | 产物 | 典型用途 |
|---|---|---|
| `block` | `标题 + "\n\n" + 正文 + "\n"` | 卡片、规则、切片、场景、楼层、文档头 |
| `line` | `标题 + "\n"` | 结束标记 |
| `seg` | `正文`（无标题） | user 通道的裸片段 |
| `seg-inline` | `标题 + "\n\n" + 正文` | user 通道里需要小标题的块（记忆层） |

`repeat: "msgs"` 表示按楼层展开，标题模板用 `{{index}}` `{{role}}`。

### 2.2 `body.from`：正文从哪来

| 取值 | 含义 |
|---|---|
| `request` | 请求体字段（如 `system`） |
| `file` | `sources` 里的具名文件 |
| `template` | `sources` 里的模板（已渲染） |
| `sample` | 素材池按楼层号确定性抽样后的条目列表 |
| `rulesText` | 注入块经关键词剔除后的文本 |
| `memory` | `<!--MEM_START-->…<!--MEM_END-->` 抽取出的记忆层 |
| `msg` | 按角色取消息（`select: last/first`，可 `tail: N` 截末 N 字） |
| `const` | 字面量 |

### 2.3 `when`：结构化条件

```jsonc
{"fact":"safeRulesChars","gt":0}
{"all":[{"fact":"slicesPicked","gt":0},{"fact":"sliceChannel","ne":"user"}]}
```

可用比较：`eq / ne / gt / gte / lt / lte / truthy`；组合：`all / any / not`。
**不允许写 JS 表达式**——这是表与代码的边界。

可用 facts：`cardChannel`、`sliceChannel`、`allowCardInUser`、`safeRulesChars`、`slicesPicked`、
`memoryChars`、`presetChars`、`hasLastUser`、`hasLastAssistant`、`floorCount`。

### 2.4 空正文

- `seg` 类节加 `"empty": "drop"`：正文为空则整节消失（user 通道靠这个避免出现空段）；
- `block` 类节**永远输出**（标题 + 两个换行 + 空正文），与"老路"行为一致。

## 三、两份产物

| 产物 | 通道 | 装什么 |
|---|---|---|
| `inputMd` | tool | 卡片、工程约束、素材切片、当前场景、写作规则、全部楼层 |
| `taskText` | user | 只有任务指令 + 记忆层 |

通道纪律靠 `channels` + 各节的 `when` 共同保证：默认配置下 user 通道里出现卡正文 = 装配失败。

## 四、判据

`verify.mjs` 要求表输出与参照实现**逐字相同**，并额外检查：

1. 每一节占据的区间必须连续、不重叠、盖满全文；
2. 节间空隙长度 = `(节数 - 1) × join.length`；
3. 同一请求跑 3 次结果一致。

差一个字就是不合格：**改表，不改装配器**。

## 五、迁移步骤（从硬编码搬到表）

1. 把现有拼装函数的输出当作参照，先写 `reference.mjs`（照抄旧逻辑）；
2. 逐段把旧代码里的 push 语句翻译成节：标题 → `heading`，内容 → `body`，条件 → `when`；
3. 每加一节跑一次 `verify.mjs`，红了就说明这节翻错了——不要靠肉眼对；
4. 全绿后再把生产代码切到 `assemble(table, …)`，`reference.mjs` 留在测试里当护栏。
