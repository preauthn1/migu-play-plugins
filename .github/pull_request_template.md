## 插件 PR 自查清单

- [ ] 目录名与 `plugin.json` 的 `id` 一致，全仓唯一
- [ ] `plugin.json` 包含全部必需字段，`version` 为 x.y.z
- [ ] `main.js` 是幂等 IIFE，带 `window.__miguPlugin_<id>` 防重注入
- [ ] 无 eval / new Function / document.write / 外部脚本 / MiguNative
- [ ] 无外部网络请求、无数据收集
- [ ] 本地 `python3 tools/validate.py` 通过
- [ ] PR 标题：`[plugin] <id> v<version>`

## 插件说明

（这个插件做什么、怎么用、截图）
