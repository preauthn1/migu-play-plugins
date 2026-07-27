# 自动剧情 (auto-skip)

移植自 [BetterGI 自动剧情](https://www.bettergi.com/feats/timer/skip.html) 的核心思路：对话/过场时连续快速点击画面对话区域跳过剧情。

- 浮动「剧情」按钮开关；开启后每 350ms 点击一次画面下方对话区。
- 云游戏没有本地画面识别，无法移植 BGI 的“自动选择选项/自动提交物品”——那部分依赖 OCR。
- 点击的是页面合成事件，補齐 `detail`/`buttons` 字段，可被云端游戏接收。
