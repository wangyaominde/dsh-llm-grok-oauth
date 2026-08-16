<p align="center">
  <img src="docs/banner.jpg" alt="dsh-llm-grok-oauth" width="920">
</p>

<h1 align="center">dsh-llm-grok-oauth</h1>

<p align="center">
  DeepSeek Harness plugin: sign in with a Grok account under Settings → Models<br>
  and run models on a SuperGrok / X Premium+ subscription. No xAI API key.
</p>

<p align="center">
  English · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f6feb?style=flat-square" alt="dsh-plugin"></a>
  <a href="https://github.com/wangyaominde/dsh-llm-grok-oauth/stargazers"><img src="https://img.shields.io/github/stars/wangyaominde/dsh-llm-grok-oauth?style=flat-square" alt="stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/wangyaominde/dsh-llm-grok-oauth?style=flat-square&label=license" alt="MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/dsh-0.1.0--rc.6+-111827?style=flat-square" alt="dsh"></a>
  <img src="https://img.shields.io/badge/API%20Key-not%20required-2ea44f?style=flat-square" alt="no api key">
</p>

---

The built-in Grok provider in DSH accepts an API key only. This plugin adds account login on the same page. The control is at:

**Settings → Models → Grok (xAI 订阅)**

<p align="center">
  <img src="docs/models-login.jpg" alt="Settings → Models → Grok (xAI 订阅)" width="720">
</p>

## Install

Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [pnpm](https://pnpm.io). If `dsh` is not on `PATH`, use `npx`:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

If the `dsh` command is already installed:

```sh
dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

Restart `dsh web` after installation. Client modules are loaded at process start; the login button will not appear until restart.

## Usage

Open **Settings → Models** and click **Sign in with Grok** on **Grok (xAI 订阅)**. Browser sign-in is the default. The official Grok CLI is not required.

1. Complete xAI authorization in the browser window (confirm the displayed code).
2. Return to a session and select a Grok model. If the current session still targets DeepSeek, start a new session before sending.

The DSH process must be able to reach `https://auth.x.ai`. If a browser can open that host but sign-in still fails, set `HTTPS_PROXY` in the environment that launches `dsh web` (or configure the macOS system proxy) and retry.

If the official Grok CLI is already signed in, that session is reused silently. Machines without the CLI are not asked to run `grok login`.

Sign-out is on the same row. Credentials are stored locally.

## Requirements

| Item | Requirement |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.6` or later |
| Account | SuperGrok or X Premium+ |
| Official Grok CLI | not required. Reused only when already signed in |
| xAI API key | not required |

## Relation to the API key field

| | This plugin | Built-in Grok config |
| --- | --- | --- |
| Location | Settings → Models | Settings → Models |
| Authentication | Grok account login | API key |
| Billing | SuperGrok / X Premium+ | xAI API credit |

Both may be configured at the same time. This plugin does not write or overwrite a saved API key.

## Uninstall

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-llm-grok-oauth
```

Restart `dsh web` after uninstall.

## License

[MIT](LICENSE)
