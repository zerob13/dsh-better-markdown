<p align="center">
  <img src="https://raw.githubusercontent.com/zerob13/dsh-better-markdown/master/assets/banner.png" alt="dsh-better-markdown — fast streaming Markdown for DeepSeek Harness" width="100%" />
</p>

<h1 align="center">dsh-better-markdown</h1>

<p align="center">
  Replace the DeepSeek Harness Web streaming Markdown path with
  <a href="https://www.npmjs.com/package/markstream-react"><code>markstream-react</code></a>.
</p>

<p align="center">
  <a href="https://github.com/zerob13/dsh-better-markdown/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/zerob13/dsh-better-markdown?style=flat" /></a>
  <a href="https://www.npmjs.com/package/dsh-better-markdown"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-better-markdown?style=flat&color=111111" /></a>
  <a href="https://github.com/zerob13/dsh-better-markdown/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zerob13/dsh-better-markdown/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111111.svg" /></a>
  <a href="https://github.com/deepseek-ai/DeepSeek-Harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek_Harness-Web-111111.svg" /></a>
  <a href="https://www.npmjs.com/package/markstream-react"><img alt="markstream-react 0.0.55" src="https://img.shields.io/badge/markstream--react-0.0.55-111111.svg" /></a>
  <a href="https://mermaid.js.org/"><img alt="Mermaid 11" src="https://img.shields.io/badge/Mermaid-11-111111.svg" /></a>
</p>

<p align="center">
  <a href="https://github.com/zerob13/dsh-better-markdown/blob/master/README.md">中文</a> · <a href="https://github.com/zerob13/dsh-better-markdown/blob/master/README_EN.md"><b>English</b></a>
</p>

`dsh-better-markdown` is a DeepSeek Harness Web client plugin. Once installed, every assistant Markdown block carrying streaming state is parsed and rendered by `markstream-react`. The same renderer stays mounted after the stream settles, so completion does not swap the message back to a different Markdown implementation.

> `markstream-react` is the official React package from the [`Simon-He95/markstream-vue`](https://github.com/Simon-He95/markstream-vue) monorepo. This plugin does not add the Vue runtime to Harness.

## Why Markstream React

- **Streaming-first parsing:** keeps handling incomplete emphasis, code fences, lists, tables, and math while LLM tokens are still arriving.
- **No completion-time renderer swap:** streaming and settled assistant messages share the same Markstream renderer.
- **Richer output:** common Markdown, tables, task lists, blockquotes, links, images, KaTeX math, and Mermaid diagrams.
- **Harness scroll-container compatibility:** disables viewport lazy mounting that cannot reliably observe nodes inside the chat scroller, preventing visible content from getting stuck as skeleton placeholders.
- **Full Markstream code blocks:** fenced code is rendered by Markstream's `MarkdownCodeBlockNode` and `stream-markdown`, with streaming Shiki highlighting plus language headers, copy actions, and expansion. Reasoning, attachments, and interruption states retain Harness behavior.
- **Explicit security policy:** raw HTML uses `htmlPolicy="escape"`; links, images, and settled file mentions retain Harness restrictions; Mermaid runs in strict mode.

## Screenshots

### Markstream code blocks

<img src="https://raw.githubusercontent.com/zerob13/dsh-better-markdown/master/screenshot/code.png" alt="DeepSeek Harness code blocks rendered inside dsh-better-markdown" width="100%" />

### Images, links, and KaTeX math

<img src="https://raw.githubusercontent.com/zerob13/dsh-better-markdown/master/screenshot/math.png" alt="Images, links and KaTeX math rendered by dsh-better-markdown" width="100%" />

### Mermaid diagrams

<img src="https://raw.githubusercontent.com/zerob13/dsh-better-markdown/master/screenshot/mermaid.png" alt="Interactive Mermaid flowchart rendered in DeepSeek Harness" width="100%" />

## Feature scope

| Capability | Behavior |
|---|---|
| Assistant streaming Markdown | Always rendered by `markstream-react` |
| Settled assistant Markdown | Keeps the same Markstream renderer |
| Mermaid | Bundles `mermaid@11.16.1`; no separate installation |
| Math | KaTeX inline and display math |
| Code fences | Uses Markstream `MarkdownCodeBlockNode` + `stream-markdown` + Shiki; unknown languages fall back to visible plain text |
| Raw HTML | Escaped as text instead of being injected into the DOM |
| Links and images | Safe external protocols only; local image files are embedded through the same-origin `/dsh-img` route (below) |
| Static plan review / trajectory surfaces | Keep Harness `MarkdownText`; these surfaces expose no shared replacement slot |

## Local image embedding

Image references in assistant Markdown may point straight at **local file paths**, with no separate static file server:

```md
![screenshot](/home/thn/dsh/shots/result.png)
![chart](file:///tmp/out/chart.webp)
![pic](~/pics/a.jpg)
```

The client rewrites local destinations to the same-origin route `/dsh-img?p=<absolute path>`; the host registers a matching GET handler on the dsh web server that streams the file. The browser resolves the URL against the page origin, so agents never need to know the port or hostname; `http(s)` remote images are unchanged.

**Accepted forms**: absolute POSIX paths, Windows drive/UNC paths (both slash and backslash spellings), and `~/` home-relative paths — bare paths must end in an image extension (`.png .jpg .jpeg .gif .webp .avif .bmp .svg`) so genuine root-relative web URLs are not swallowed; explicit `file://` destinations are normalized to absolute paths before parsing (the upstream sanitizer drops non-http(s) image schemes). Percent escapes in a destination (`%20`, …) are decoded exactly once before routing, so encoded file names resolve to real files; a malformed escape falls back to alt text.

**Security boundary**: by default only files under registered workspace directories are served (checked after `realpath` normalization), plus an extension allowlist, a file-header signature check, and a 20 MiB size cap. The route is same-origin with the GUI (the web server binds loopback by default); widen it from a profile patch layer if needed:

```yaml
# == dsh-better-markdown
- id: better-markdown
  config:
    # extraRoots: [/tmp, /home/thn/pics]   # additional allowed directories
    # allowAny: true                        # any readable file (most permissive; pure-local setups)
    # maxBytes: 52428800                    # size cap, default 20 MiB
    # extensions: [.png, .jpg]              # served extension list (empty = serve nothing)
```

## How it works

The plugin uses the public Harness client-module and slot-shadowing APIs. It does not patch Harness files or replace React globally.

```text
Assistant token stream
  -> Harness session projection
  -> conversation.chat.node / assistant-step
       |- priority -100: BetterAssistantNodeView
       |                  -> markstream-react  (active)
       |                       `- fenced code -> stream-markdown -> Shiki
       `- priority    0: Harness built-in      (fallback)
```

The shadow entry handles normal rendering. If the plugin renderer throws or is unloaded, the original Harness renderer remains registered and takes over.

## Installation

### Install from npm (recommended)

Prerequisite: a working DeepSeek Harness Web installation.

```sh
dsh plugin --profile web add dsh-better-markdown
dsh --profile web --dump-config
dsh --profile web
```

Update the plugin:

```sh
dsh plugin --profile web add dsh-better-markdown@latest
```

### Install from source

Prerequisites: a working DeepSeek Harness Web installation, Node.js 20+, and pnpm 10+.

```sh
git clone https://github.com/zerob13/dsh-better-markdown.git
cd dsh-better-markdown
pnpm install
pnpm run check
pnpm run build
dsh plugin --profile web add "$(pwd)"
dsh --profile web --dump-config
dsh --profile web
```

On Windows PowerShell, replace `"$(pwd)"` with `(Get-Location).Path`.

The composed configuration should include:

```yaml
# == dsh-better-markdown
- id: better-markdown
  name: dsh-better-markdown
```

Rendered assistant Markdown carries this verification marker:

```html
<div data-markdown-renderer="markstream-react">
```

### Install directly from Git

Git dependencies run the repository's `prepare` build. pnpm 10/11 may require explicit permission in the Web profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-better-markdown: true
```

Then install and start Harness:

```sh
dsh plugin --profile web add git+https://github.com/zerob13/dsh-better-markdown.git
dsh --profile web
```

Pin a commit SHA for production use instead of following the default branch indefinitely.

## Remove

To remove the plugin:

```sh
dsh plugin --profile web remove dsh-better-markdown
```

Unloading disposes the slot shadow and Markstream component policy, immediately restoring the built-in renderer.

## Bundle trade-offs

- `markstream-react`: `0.0.55`
- `mermaid`: `11.16.1`
- `stream-markdown`: `0.0.16`
- `shiki`: `4.4.3`
- Current browser bundle: about 7.40 MB, about 1.59 MB gzip
- Mermaid and Shiki syntax highlighting are bundled for offline use; Shiki uses its JavaScript regex engine and a fine-grained bundle of 34 common languages
- The optional Monaco runtime, D2, and Infographic peers are not bundled; unknown code languages use Markstream's plain-text fallback

Removing Mermaid can substantially reduce the bundle, but Mermaid fences will no longer produce diagram previews.

## Development

```sh
pnpm install
pnpm run check
pnpm run build
pnpm pack --dry-run
```

Maintainers release by matching the `package.json` version to a `vX.Y.Z` tag and publishing the corresponding GitHub Release. `publish.yml` validates the version, runs checks and a build, then publishes the public package through npm trusted publishing. Prereleases are not published.

Key files:

- `src/client/index.ts`: Markstream component policy and assistant slot shadow
- `src/client/renderer.tsx`: assistant node and Markdown renderer
- `src/client/shiki.ts`: fine-grained Shiki bundle for the single-file plugin build
- `src/client/styles.css`: Harness token adaptation
- `cordis.patch.yml`: plugin bundle row
- `tests/plugin.spec.tsx`: streaming, fallback, security, and Mermaid routing tests

## Compatibility

- DeepSeek Harness `0.1.0-rc.5` or newer
- React 18 or newer
- Replaces only the Web conversation `assistant-step`
- Older Harness builds without priority-based slot shadowing fail at load time instead of mounting two renderers

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)
- [markstream-vue / markstream-react](https://github.com/Simon-He95/markstream-vue)
- [Mermaid](https://github.com/mermaid-js/mermaid)

## License

[MIT](./LICENSE)
