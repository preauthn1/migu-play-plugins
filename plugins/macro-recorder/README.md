# 键鼠录制 (macro-recorder)

移植自 [BetterGI 键鼠录制](https://www.bettergi.com/feats/autos/kmscript.html)：录制你在游戏画面上的点击（含触屏），带时间轴循环回放。

- 「录」开始/停止录制；「放」循环回放/停止。
- 回放使用 `elementFromPoint` 定位当前元素并派发补齐字段的合成点击。
- 适合重复性 UI 操作（领奖励、合成、兑换）。
