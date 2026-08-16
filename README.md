<p align="center">
  <img src="docs/banner.jpg" alt="dsh-llm-grok-oauth" width="920">
</p>

<h1 align="center">dsh-llm-grok-oauth</h1>

<p align="center">
  你已经有 Grok 会员，就能在 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 里用 Grok。<br>
  不用再去 xAI 买 API Key。
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

DSH 自带的 Grok 只能填 API Key。这个插件多做一件事：让你用 **Grok 网页账号** 登录。

会员指 SuperGrok，或者 X Premium+。有其中一个就行。

<p align="center">
  <img src="docs/models-login.jpg" alt="设置里的 Grok 登录按钮" width="720">
</p>
<p align="center">
  <sub>登录按钮在：设置 → 模型 → Grok (xAI 订阅)</sub>
</p>

## 装

先装好 DSH，然后在终端执行：

```sh
dsh plugin --profile web add github:wangyaominde/dsh-llm-grok-oauth
```

装完后把 `dsh web` **关掉再开一次**。不重启的话，设置页还看不到登录按钮。

## 用

1. 打开 DSH，进 **设置 → 模型**。
2. 找到 **Grok (xAI 订阅)**，点 **使用 Grok 账号登录**。
3. 浏览器会弹出 xAI 的确认页。页面上有一串代码，对上之后点确认。
4. 回到 DSH 开一个对话，模型列表里选 Grok，就可以聊天了。

退出登录也在同一块地方。登录过期后会自己续上，不用每次重新点。

电脑上如果已经登录过官方 Grok 命令行，点登录时会直接用那份，不必再授权一次。

## 你要准备什么

| | |
| --- | --- |
| DSH `0.1.0-rc.6` 或更新 | 要 |
| SuperGrok 或 X Premium+ | 要 |
| 官方 Grok 命令行 | 可有可无 |
| xAI 的 API Key | 不要 |

## 和填 API Key 有什么不一样

| | 这个插件 | DSH 自带的填 Key |
| --- | --- | --- |
| 你怎么登录 | 点按钮，用 Grok 账号 | 把一串 Key 粘进去 |
| 钱从哪扣 | 你的 Grok 会员 | xAI 控制台里的 API 余额 |
| 要不要新开一页 | 不用 | 不用 |

两套可以同时存在。这个插件不会改掉你已经填过的 API Key。

## 卸

```sh
dsh plugin --profile web remove dsh-llm-grok-oauth
```

再把 `dsh web` 关掉开一次。

## 许可

[MIT](LICENSE)
