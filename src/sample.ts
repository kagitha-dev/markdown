export const SAMPLE_NAME = 'welcome.md'

export const SAMPLE = `---
type: guide
title: kagitha Markdown Viewer
description: A free, private Markdown viewer with YAML frontmatter and Open Knowledge Format support.
author: Prasad Kagitha
updated: 2026-11-25
status: draft
tags: [markdown, frontmatter, okf]
related:
  - getting-started.md
  - okf-bundles.md
---

# Free online Markdown viewer

Open a \`.md\` file and read it as a clean, formatted page. Your file is **opened in your browser and never uploaded**: there is no account, no cookies, and nothing about your files leaves your browser.

> **Try it:** drop a \`.md\` file onto this window, press **Open**, or paste Markdown with **Paste**. To read a whole set of notes, open a **Folder** or a \`.zip\` file.

The panel beside this page reads the YAML frontmatter at the top of the file and shows it as a tidy card. If a file uses Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) (OKF), its \`type\` field is highlighted.

To find words in the open file, press the search button or **Ctrl/Cmd+F**: every match is highlighted and counted, and Enter steps to the next one.

## What renders

| Feature | Syntax | Supported |
| :-- | :-- | :-: |
| Tables, task lists, strikethrough | GitHub Flavored Markdown | ✓ |
| Code highlighting | Fenced blocks with a language, 20+ languages | ✓ |
| Math | \`$inline$\` and \`$$block$$\` | ✓ |
| Diagrams | Fenced blocks marked \`mermaid\` | ✓ |
| Footnotes | \`[^1]\` | ✓ |
| Raw HTML | sanitized, scripts removed | ✓ |

## Whole folders

Press **Folder** (or drop a folder onto this window) to open a set of notes, docs or a wiki:

- A **file tree** in the side panel, with the folder's \`index.md\` or \`README.md\` shown first
- **Links between files** work, including \`../other.md#a-heading\`, and the browser's Back and Forward buttons move between them
- **Images** with relative paths, such as \`![diagram](img/flow.png)\`, are shown from the folder
- **Search across every file** (Ctrl/Cmd+K), with the matching words highlighted

## Open Knowledge Format bundles

Open an [OKF](https://github.com/open-knowledge-format/open-knowledge-format) bundle as a folder or as a \`.zip\` file, and the viewer understands it:

- **Contents** built from the bundle's \`index.md\` files, with its title, description and license
- **Checks** against the OKF v0.3 rules: a missing \`type\`, broken links and paths, unreadable frontmatter, stale entries (\`stale_after\`), and verifications that are out of date
- **Trust and freshness** for each concept: status, trust tier (unverified, machine-confirmed, human-reviewed), and when it goes stale
- A **graph** of how the files link together, coloured by \`type\`
- **Filters** by type, status, tag, trust, freshness and date, plus the files that link to the one you're reading

Recent files and folders are listed on this page, and are kept only in your browser. The viewer can also be **installed as an app** that works offline.

### Roadmap

- [x] Single-file viewer with frontmatter card
- [x] Light and dark themes
- [x] Open whole folders, with search across files
- [x] Installable app that works offline
- [x] OKF bundle validator, graph view and filters
- [x] Open bundles from .zip files

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

Everything happens in your browser. Folders are read straight from your disk and nothing is copied anywhere. The fonts, the code highlighter and the diagram renderer are all served from this site, so opening a file makes no requests to anyone else. The only other request is an anonymous visit count to kagitha.com, at most once a day: it sends the word \"markdown\" and nothing else, no cookies, file names or contents. You can check all of this in your browser's developer tools, on the Network tab.

## Notes

Frontmatter errors are reported with a line number, so a missing colon or a bad indent is easy to find.[^yaml]

Made by [Prasad Kagitha](https://kagitha.com).

[^yaml]: The viewer uses the \`yaml\` library, which follows YAML 1.2.
`
