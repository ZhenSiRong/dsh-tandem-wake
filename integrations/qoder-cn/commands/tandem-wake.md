---
name: tandem-wake
description: 检查 Tandem 文档里的新批注并逐条处理（不自动接受，只出建议）
---

# /tandem-wake

把「人在 Tandem 文档里留的话」搬到这次对话里处理掉。适用于 Qoder CN 这种不支持 push 通知的宿主：**没有后台唤醒，所以你手动敲一次这个命令**。

## 执行步骤

0. **先看文档能不能改**（这一步最容易翻车）：调用 `tandem_listDocuments`，看目标文档的 `readOnly` 与 `source`。

   | 看到 | 含义 | 怎么办 |
   |---|---|---|
   | `readOnly: true` + `source: "upload"` | 拖拽上传的副本，Tandem 在 `openFromUpload()` 里把只读**写死**（没有磁盘路径，改不回去） | **不要尝试编辑**。告诉人：用磁盘上的真实路径 `tandem_open({filePath})` 重开；顺带提醒只有 `md`/`txt`/`docx` 可编辑，`.html` 打开就是只读 |
   | `readOnly: false` + `source: "file"` | 正常 | 继续，但要提醒人：**Accept 之后会自动写回磁盘文件**，`git status` 会看到改动 |

   如果用户只是想试效果、不想动真文件，建议先把内容复制到临时路径再开副本。

1. **取件**：调用 MCP 工具 `tandem_checkInbox`（如果你的宿主支持 `cursor` 参数，**一定要带上并回传**：不带 cursor 时条目是所有调用者共享的一次性投递，会把本该给别人的评论取走；带 cursor 则每个消费者独立账本）。
   取到之后**先分拣**：只有正文里 `@Qoder` 的条目才归你处理；`@DSH` 的是别人的；**没有任何 @ 的，谁都不动手**（只读、只报告）。（若工具名带前缀，形如 `mcp__tandem__tandem_checkInbox`）。
   - 返回 `hasNew: false` → 回一句「Tandem 没有新批注」，**结束本轮，不要做任何编辑**。
2. **定位**：对每条 `author === "user"` 且 `@Qoder` 的评注，用 `tandem_resolveRange`（按评注里的 `textSnippet`）或 `tandem_getContext` 拿到它实际锚定的文本与上下文。
   - 拿不到锚点（文本已被改动）→ 用 `tandem_search` 找最接近的一段；仍找不到就在对话里说明，不要猜着改。
3. **给建议**：用 `tandem_comment` 在**同一区间**上写一条建议：
   - `text`：用中文说明**为什么**这么改（一句话，说清取舍，不要复述原文）。
   - `suggestedText`：替换后的文本，**保持原文语言**与 Markdown 结构。
   - 带上 `textSnapshot` 防止区间漂移。
4. **回报**：用 `tandem_annotationReply` 或 `tandem_reply` 回一句话，告诉人你动了哪里；然后在对话里列出「评注 → 我建议了什么」。

## 硬性边界

- **没 @ 你就不动手**：没 @任何人、或 @ 的是别家的条目，一律只读 + 一句话报告（"这条没有 @ 我"），不要替人决定。
- **只读文档一律不动手**（`readOnly: true`），先要人换成磁盘路径再谈编辑。
- **绝不代替人点 Accept**：`tandem_resolveAnnotation` 只允许对**你自己写的**建议做 dismiss（撤回），不接受。
- 一次只处理评注锚定的那一块；不要顺带"优化"别的段落。
- 评注是命令（"翻译成英文"）就照做；是提问（"这句是不是太虚"）就回答并在必要时给建议，别擅自重写。
- 拿不准就只回答、不改文档。

## 前提

宿主里要已配置 Tandem MCP：端点 `http://127.0.0.1:3479/mcp`（Tandem 在跑时才有）。连不上就先提示用户启动 `tandem`。
