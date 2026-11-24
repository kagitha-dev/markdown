export const SAMPLE_NAME = 'welcome.md'

export const SAMPLE = `---
type: guide
title: kagitha Markdown Viewer
description: A free, private Markdown viewer with YAML frontmatter and Open Knowledge Format support.
author: Prasad Kagitha
updated: 2026-11-24
status: beta
tags: [markdown, frontmatter, okf]
related:
  - getting-started.md
  - okf-bundles.md
---

# Free online Markdown viewer

Open a \`.md\` file and read it as a clean, formatted page. Your file is **opened in your browser and never uploaded**: there is no server, no account and no tracking.

> **Try it:** drop a \`.md\` file onto this window, press **Open**, or paste Markdown with **Paste**.

The panel beside this page reads the YAML frontmatter at the top of the file and shows it as a tidy card. If a file uses Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) (OKF), its \`type\` field is highlighted.

## What renders

| Feature | Syntax | Supported |
| :-- | :-- | :-: |
| Tables, task lists, strikethrough | GitHub Flavored Markdown | ✓ |
| Code highlighting | Fenced blocks with a language, 20+ languages | ✓ |
| Math | \`$inline$\` and \`$$block$$\` | ✓ |
| Diagrams | Fenced blocks marked \`mermaid\` | ✓ |
| Footnotes | \`[^1]\` | ✓ |
| Raw HTML | sanitized, scripts removed | ✓ |

### Roadmap

- [x] Single-file viewer with frontmatter card
- [x] Light and dark themes
- [ ] Open whole folders
- [ ] OKF bundle validator and graph view

## Code

\`\`\`ts
import { parseDocument } from 'yaml'

export function readFrontmatter(src: string) {
  const match = /^---\\n([\\s\\S]*?)\\n---/.exec(src)
  return match ? parseDocument(match[1]).toJS() : null
}
\`\`\`

\`\`\`yaml
# An OKF concept file only needs a type
type: metric
title: Weekly active users
\`\`\`

## Math

The reading time shown in the status bar uses $t = \\lceil w / 220 \\rceil$ minutes for $w$ words. Display math works too:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

## Diagram

\`\`\`mermaid
flowchart LR
  A[Markdown file] --> B{Has frontmatter?}
  B -- yes --> C[Metadata card]
  B -- no --> D[Body only]
  C --> E[Rendered page]
  D --> E
\`\`\`

## Privacy

Everything happens in your browser. The fonts, the code highlighter and the diagram renderer are all served from this site, so opening a file makes no requests to anyone else. You can check this in your browser's developer tools, on the Network tab.

## Notes

Frontmatter errors are reported with a line number, so a missing colon or a bad indent is easy to find.[^yaml]

Made by [Prasad Kagitha](https://kagitha.com).

[^yaml]: The viewer uses the \`yaml\` library, which follows YAML 1.2.
`
