# dsh-llm-grok-oauth

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)

Grok subscription OAuth plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds **Sign in with Grok** on **Settings → Models → Grok (xAI 订阅)** so SuperGrok / X Premium+ can drive the harness. No DSH core changes. No API key field.

DeepSeek Harness 的 Grok 订阅 OAuth 插件。在 **设置 → 模型 → Grok (xAI 订阅)** 里一键登录，用订阅跑模型。

## Install

```sh
dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

Restart `dsh web`, open **Settings → Models**, click **Sign in with Grok** on the Grok card, and authorize with your own account.

If the official Grok CLI is already signed in, `~/.grok/auth.json` is reused.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or newer (`dsh web`)
- SuperGrok or X Premium+

## License

MIT
