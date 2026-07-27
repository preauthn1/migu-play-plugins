# Migu Play 插件仓库

咪咕游戏中心（[migu-play](https://github.com/preauthn1/migu-play)）的官方公开插件仓库。参考 [better-genshin-impact](https://github.com/babalae/better-genshin-impact) 的社区脚本仓库模式：**任何人按规范提交 PR，通过 CI 校验与人工审核后即上架**，App 内即可一键安装启用。

## 插件是什么

插件是一段注入到游戏 WebView 页面的 JavaScript（IIFE），可以读取/修改页面 DOM、监听事件、通过 `MiguPlugin` API 与宿主交互。典型用途：画面滤镜、性能显示、辅助按钮、页面清理等。

## 目录结构

```text
plugins/
  <plugin-id>/            # 小写字母数字与连字符，全仓唯一
    plugin.json           # 插件清单（必需）
    main.js               # 插件入口（必需，UTF-8）
    README.md             # 插件说明（必需）
index.json                # CI 自动生成的插件索引，请勿手改
```

## plugin.json 规范

```json
{
  "id": "fps-overlay",
  "name": "帧率显示",
  "version": "1.0.0",
  "author": "yourname",
  "description": "在游戏画面角落显示实时 FPS。",
  "homepage": "https://github.com/yourname",
  "match": ["*"],
  "minAppVersion": "2.14.0",
  "permissions": []
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]{1,40}$`，与目录名一致 |
| `name` | ✅ | 展示名，≤ 20 字符 |
| `version` | ✅ | 语义化版本 `x.y.z` |
| `author` | ✅ | 作者名或 GitHub 用户名 |
| `description` | ✅ | ≤ 100 字符 |
| `match` | ✅ | URL 通配符数组；`*` 表示所有游戏页面 |
| `minAppVersion` | ✅ | 所需最低 App 版本 |
| `homepage` | ❌ | 主页/仓库链接 |
| `permissions` | ❌ | 保留字段，当前必须为 `[]` |

## main.js 规范

1. 必须是 IIFE：`(function () { ... })();`，不污染全局作用域（只允许挂 `window.__miguPlugin_<id>` 一个命名空间，用于防重复注入）。
2. 必须幂等：脚本可能在 `onPageStarted` / `onPageFinished` 各注入一次，须用命名空间防重复。
3. 体积 ≤ 64 KB；禁止 `eval`、`new Function`、`document.write`、动态加载外部脚本（`<script src>` / `import()`）。
4. 禁止访问 `MiguNative` 原生通道（宿主专用）；插件与宿主交互只能通过后续开放的 `MiguPlugin` API。
5. 禁止收集、上传用户数据；禁止请求本仓库之外的网络资源（CSS/图标请内联）。
6. 顶部注释写明插件名、功能、作者。

## 提交流程

1. Fork 本仓库；
2. 新建 `plugins/<your-plugin-id>/`，添加 `plugin.json`、`main.js`、`README.md`；
3. 本地自检：`python3 tools/validate.py`；
4. 提交 PR，标题：`[plugin] <id> v<version>`；
5. CI 自动校验（清单 schema、目录一致性、JS 静态检查、体积），通过后等待人工审核合并；
6. 合并后 CI 重建 `index.json`，App 内插件市场即可看到。

更新插件同理：修改文件并递增 `version` 后提交 PR。

## 审核红线

以下情况直接拒绝：混淆/加密代码、外部网络请求、数据收集、广告注入、绕过咪咕计费或会员机制、任何形式的账号窃取。

## License

MIT — 提交 PR 即表示同意以 MIT 协议发布你的插件。
