# Qoder DSH Bridge

Windows 上的本地桥接项目：通过已登录的 Qoder CN CLI，将模型接入 DeepSeek Harness（DSH）。这是独立社区项目，与 Qoder 和 DeepSeek 无官方关联；不包含 Qoder CLI、账户凭据或模型权重。

## 功能与边界

- 支持流式文本、思考内容、图片输入和经 Qoder 原生 MCP 机制转交给 DSH 的工具调用。模型能力取决于 Qoder 账号及其当前返回的数据。
- 同一会话在配置与历史匹配时复用 CLI；聊天和压缩可各自预热。冷启动、上游排队和复杂任务仍可能较慢。
- 模型选择器显示 Qoder 返回的免费状态或额度倍率。倍率并非固定单次价格，也不是人民币价格。
- `查看Qoder用量.bat` 显示账户额度和已记录的请求用量。当前 CLI 在流式模式可能缺少单次 Credits；窗口同时展示会话累计差额，二者可能重复统计，不能相加。
- CLI 磁盘会话持久化默认关闭。进程重启后通过 DSH 提供的历史重建上下文，不能保证和原生角色历史完全一致。活动边界采用模拟时间测试，真实切换时仍需验证。

## 准备

Windows 10/11、Node.js 22.19 或更高版本、已安装并登录的 Qoder CN CLI、兼容的 DSH 桌面版。本项目只在特定版本的 Windows、DSH 和 Qoder CN CLI 上验证；CLI 的控制协议或 DSH 插件接口更新可能导致不兼容。请自行遵守 Qoder、DSH 及其模型服务的使用条款与计费规则。

在 PowerShell 进入项目目录并执行：

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\init-token.ps1
node .\qoder-cli-proxy.mjs
```

代理默认仅监听 `127.0.0.1:18082`。CLI 默认位置为 `%USERPROFILE%\.qodersec\bin\qoderclicn.exe`；可用 `--cli` 或 `QCP_CLI` 指定实际路径。本地令牌位于 `%USERPROFILE%\.dsh\qoder-bridge-v2\token`，不要分享或提交。已有令牌会保留。代理前台运行期间打开 `http://127.0.0.1:18082/healthz` 可检查状态；关闭窗口会停止代理。

## 接入 DSH

1. 完全退出 DSH，并备份 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 和任何同名插件目录。
2. 将本项目 `plugin` 文件夹复制为 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-qoder-connect`。不要覆盖已有同名插件，除非已自行确认和备份。
3. 在桌面 profile 的 `cordis.patch.yml` 中添加以下顶层条目（确保原文件仍是合法 YAML）：

   ```yaml
   - insert:
       - id: llm-qoder
         name: dsh-qoder-connect
   ```

4. 保持代理运行，重新打开 DSH，在模型选择器中选择 Qoder CN。插件依赖 DSH 已安装的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai` 和 `@earendil-works/pi-ai`；若版本不兼容，请检查 DSH 日志。

## 隐私、用量与诊断

代理仅允许本机 HTTP，不接受带浏览器 Origin 的请求；除健康检查外需要本地令牌。用量记录和最近路由放在令牌目录，只包含元数据，不包含对话内容或工具参数。日志不记录对话正文，但模型名和耗时仍可能属于敏感数据。`model-catalog.json`、日志、用量、令牌和依赖目录被 `.gitignore` 排除。

账户额度是整个 Qoder 账号的快照，不等于代理记录的总和。以 [Qoder Credits 文档](https://docs.qoder.cn/cli/sdk/cost-usage) 和账户实际账单为准。

## 测试

```powershell
npm test
```

测试使用合成 CLI，不需要登录 Qoder，也不会执行真实工具；HTTP 测试需要访问本机回环地址。真实模型、桌面 UI、计费及活动切换需要另行验证。

本项目源代码采用 MIT 协议；Node 依赖、DSH、Qoder CLI 和模型服务各自受其相应协议约束。
