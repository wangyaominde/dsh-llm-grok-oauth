<p align="center">
  <img src="docs/banner.jpg" alt="dsh-llm-grok-oauth" width="920">
</p>

<h1 align="center">dsh-llm-grok-oauth</h1>

<p align="center">
  DeepSeek Harness 插件：在「设置 → 模型」中通过 Grok 账号登录，<br>
  使用 SuperGrok / X Premium+ 订阅调用模型，无需 xAI API Key。
</p>

<p align="center">
  <a href="README.en.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f6feb?style=flat-square" alt="dsh-plugin"></a>
  <a href="https://github.com/wangyaominde/dsh-llm-grok-oauth/stargazers"><img src="https://img.shields.io/github/stars/wangyaominde/dsh-llm-grok-oauth?style=flat-square" alt="stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/wangyaominde/dsh-llm-grok-oauth?style=flat-square&label=license" alt="MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/dsh-0.1.0--rc.6+-111827?style=flat-square" alt="dsh"></a>
  <img src="https://img.shields.io/badge/不需要-API%20Key-2ea44f?style=flat-square" alt="no api key">
</p>

---

DSH 内置的 Grok 配置仅支持填写 API Key。本插件在同一页面增加账号登录，登录入口位于：

**设置 → 模型 → Grok (xAI 订阅)**

<p align="center">
  <img src="docs/models-login.jpg" alt="设置 → 模型 → Grok (xAI 订阅)" width="720">
</p>

## 安装

本机需已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [pnpm](https://pnpm.io)。未将 `dsh` 加入 PATH 时，使用 `npx`：

```sh
npx @deepseek-ai/dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

已安装 `dsh` 命令时：

```sh
dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

安装完成后须重启 `dsh web`。客户端模块仅在进程启动时加载，未重启则设置页不会出现登录按钮。

## 使用

1. 打开 **设置 → 模型**。
2. 在 **Grok (xAI 订阅)** 中点击 **使用 Grok 账号登录**。
3. 在打开的浏览器窗口中完成 xAI 授权（核对页面上的确认代码后确认）。
4. 返回会话，在模型列表中选择 Grok 模型。

退出登录位于同一条目。登录状态保存在本机；过期后自动刷新，无需重复授权。

若本机已通过官方 Grok CLI 登录（存在 `~/.grok/auth.json`），将复用该会话。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.6` 及以上 |
| 账号 | SuperGrok 或 X Premium+ |
| 官方 Grok CLI | 可选 |
| xAI API Key | 不需要 |

## 与 API Key 配置的关系

| | 本插件 | DSH 内置 Grok 配置 |
| --- | --- | --- |
| 入口 | 设置 → 模型 | 设置 → 模型 |
| 认证方式 | Grok 账号登录 | 填写 API Key |
| 计费 | SuperGrok / X Premium+ 订阅 | xAI API 余额 |

两者可同时存在。本插件不写入、不覆盖已保存的 API Key。

## 卸载

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-llm-grok-oauth
```

卸载后须重启 `dsh web`。

## 许可

[MIT](LICENSE)
