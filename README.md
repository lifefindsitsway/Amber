<p align="center">
  <img src="src/desktop/icons/128x128@2x.png" alt="Amber" width="160">
</p>

<h1 align="center">Amber（琥珀）</h1>

<p align="center"><em>Knowledge finds its way</em></p>

Amber 是一款开源的 AI 音视频处理工具，用户可以导入本地或平台（Bilibili/YouTube）上的音视频，取得带时间戳的字幕文稿，再用 AI 校对、总结、翻译等。

发布形式：Windows 客户端。数据只保存在用户电脑上，免费，无遥测，自带模型密钥（BYOK）。许可证为 AGPL-3.0-only。

## 功能特性

- **多来源导入**：本地音视频文件、B 站与 YouTube 链接（合集、播放列表可整批导入）；可为音视频附带导入 SRT / VTT 字幕。
- **文稿获取**：平台字幕、导入的字幕文件，或语音转录。转录服务当前支持 ElevenLabs 与阿里云百炼，可在其下添加模型，后续会增加更多服务商。
- **灵活接入 AI 模型**：添加多个模型服务，包括自定义 Base URL 与模型 ID；当前支持 OpenAI 兼容与 Anthropic Messages 两种协议。
- **AI 整理**：校对、分章、总结（单条内容与合集归纳）、AI 高光、翻译。AI 处理只在用户点「开始处理」或手动发起时进行，原文改动后不会自动重算。
- **学习**：全文搜索、基于文稿的 AI 对话（回答附可跳转的原文出处）、笔记（下划线、高亮、评论）、术语表。
- **字幕与导出**：导出 Markdown，以及 SRT、VTT、TXT、ASS 字幕（SRT 与 ASS 可双语，ASS 带样式）；也可导出带字幕的视频（硬字幕或软字幕轨）。
- **界面**：四套主题（浅色、深色、经典豆沙绿、羊皮纸）。

## 下载与安装

- 系统要求：Windows 11（64 位）。
- 在 [Releases](https://github.com/lifefindsitsway/Amber/releases) 下载 `Amber_<版本>_x64-setup.exe` 并运行。
- 安装包尚未使用 Windows 代码签名（Authenticode），部分设备上 SmartScreen 可能提示。请先核对下载来源是本仓库的 Releases 页面，再自行决定是否继续安装。
- 更新：客户端启动时检查一次更新，发现新版本只提示，由用户决定是否下载安装；可在「关于 Amber」中关闭自动检查或手动检查。

## 快速开始

1. 在「新总结」里选择本地音视频文件，或粘贴 B 站 / YouTube 链接，点「开始处理」。
2. 文稿优先取平台字幕；没有字幕时，在「功能设置」里添加一个转录服务后生成。部分平台字幕需要登录才能取得，可在「功能设置 › 平台账号」登录。
3. 需要 AI 处理时，在「功能设置 › 模型」里添加模型服务，然后对文稿做校对、总结、翻译或对话。

## 数据与隐私

- 资料库只保存在本机，客户端无需注册或登录，项目不收集任何遥测数据。
- 会访问网络的操作包括：获取平台内容、调用用户配置的 AI 服务、检查更新等。发送给 AI 服务的音频与文稿受该服务商的隐私政策约束，费用也由它收取。
- API Key 加密保存在本机。
- 备份：可把整个资料库导出为一个 `.amberbackup` 文件。备份不含 API Key 与平台登录状态；文件未加密，请妥善保管；只能恢复到全新安装的 Amber，不支持合并。

## 开发指南

### 环境要求

- Node.js：满足 `package.json` 的 `engines`。
- pnpm：版本见 `package.json` 的 `packageManager`，可经 Corepack 启用。
- 构建 Windows 安装包另需 Rust 与 Tauri 构建环境；日常开发不需要。

开发环境与宿主无关，Linux、WSL 或其它能运行上述工具的机器均可。

### 本地开发

```sh
git clone https://github.com/lifefindsitsway/Amber.git
cd Amber
pnpm install --frozen-lockfile
gh release download runtime-assets-2026.10.21 --repo lifefindsitsway/amber-runtime-assets --dir runtime-assets
pnpm setup:tools --assets runtime-assets
pnpm dev
```

yt-dlp、FFmpeg、Deno 与字幕字体来自固定版本的 Amber Runtime Assets，发布在资源仓库 [lifefindsitsway/amber-runtime-assets](https://github.com/lifefindsitsway/amber-runtime-assets) 的 Release `runtime-assets-2026.10.21`。每个文件的版本与 SHA256 以 Release 附带的 `manifest.json` 与 `SHA256SUMS` 为准；`pnpm setup:tools` 会先核对 `SHA256SUMS` 的摘要，再按它校验每个文件后安装到 `.amber-tools/`。只需要本机平台的文件时，可以用 `--pattern` 只下载部分文件，做法见 `.github/workflows/ci.yml`。

`node_modules/`、`dist/`、`.amber-tools/`、`src/desktop/gen/` 都可以删除后重新生成。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 本地模式后端 + Vite 开发服务器（`http://localhost:5173`），数据在 `.amber-dev/` |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 单元与组件测试 |
| `pnpm test:file -- <路径>` | 运行指定测试文件 |
| `pnpm test:guards` | 结构化守卫（依赖边界、凭据扫描等） |
| `pnpm test:e2e` | 浏览器冒烟测试（需先 `pnpm exec playwright install chromium`） |
| `pnpm build` | 构建前端与服务器产物到 `dist/` |

### 项目结构

| 目录 | 内容 |
|---|---|
| `src/shared/` | 前后端共用的类型、枚举、默认值与界面文案 |
| `src/server/` | 后端：API、应用服务、领域模型、任务管线与各类 adapter |
| `src/web/` | React 前端 |
| `src/desktop/` | Tauri 外壳（Rust），只负责窗口、文件选择、sidecar 生命周期等 |
| `src/tooling/` | 构建、打包、版本检查等工具脚本 |
| `test/` | 测试，目录镜像 `src/` |

后端按 Ports & Adapters 组织：应用服务、领域模型与管线只依赖 port 接口，具体实现在 `src/server/adapters/`。`pnpm test:guards` 会检查这些依赖边界。

### 服务器模式

同一套代码还有一个多用户的服务器模式，只用于开发与自动化测试，缺省只监听 `127.0.0.1`：

```sh
pnpm build
AMBER_MODE=server AMBER_DATA_DIR=<数据目录> AMBER_BIN_DIR=.amber-tools/bin \
AMBER_PUBLIC_ORIGIN=http://127.0.0.1:3000 node dist/server/server.js
```

首次启动会在控制台输出一次性 setup token，打开 `http://127.0.0.1:3000/setup` 创建管理员。

## 许可证

Amber 以 [AGPL-3.0-only](LICENSE) 发布。安装包附带 `LICENSE`、`THIRD_PARTY_NOTICES.md`（第三方组件及许可证）与 `SOURCE.md`（源码获取方式）。安装包中的 FFmpeg 为 GPL 构建，其完整对应源码与第三方许可证包发布在上述 Runtime Assets Release 中，地址见 `SOURCE.md`。

## 反馈与贡献

问题与建议请提交到 [Issues](https://github.com/lifefindsitsway/Amber/issues)。较大的改动请先开 Issue 讨论，再提交 Pull Request。
