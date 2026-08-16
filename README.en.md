<p align="center">
  <img src="docs/banner.jpg" alt="dsh-llm-grok-oauth" width="920">
</p>

<h1 align="center">dsh-llm-grok-oauth</h1>

<p align="center">
  If you already pay for Grok, you can use it in <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.<br>
  You do not need an xAI API key.
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

DSH’s built-in Grok setup only accepts an API key. This plugin adds one extra thing: **log in with your Grok website account**.

That means SuperGrok, or X Premium+. Either one is enough.

<p align="center">
  <img src="docs/models-login.jpg" alt="Grok sign-in button in Settings" width="720">
</p>
<p align="center">
  <sub>The button is at: Settings → Models → Grok (xAI 订阅)</sub>
</p>

## Install

Install DSH first, then run:

```sh
dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

Then **quit and start `dsh web` again**. If you skip the restart, the sign-in button will not show up.

## Use

1. Open DSH. Go to **Settings → Models**.
2. Find **Grok (xAI 订阅)** and click **使用 Grok 账号登录** (Sign in with Grok).
3. A browser window opens. Match the code on the page and confirm.
4. Go back to a chat in DSH, pick a Grok model, and talk.

Sign out is on the same card. After you are signed in, DSH keeps you signed in; you do not click this every time.

If this computer already signed in with the official Grok command line, clicking the button reuses that login.

## What you need

| | |
| --- | --- |
| DSH `0.1.0-rc.6` or newer | yes |
| SuperGrok or X Premium+ | yes |
| Official Grok CLI | optional |
| An xAI API key | no |

## vs pasting an API key

| | This plugin | DSH’s built-in key field |
| --- | --- | --- |
| How you sign in | Click a button, use your Grok account | Paste a key |
| What you pay with | Your Grok subscription | API credit in the xAI console |
| Extra page | no | no |

You can keep both. This plugin does not overwrite a key you already saved.

## Uninstall

```sh
dsh plugin --profile web remove dsh-llm-grok-oauth
```

Then quit and start `dsh web` again.

## License

[MIT](LICENSE)
