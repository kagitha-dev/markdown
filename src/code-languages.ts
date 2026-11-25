/*
 * Highlighting inside fenced code blocks in the editor: the same languages the preview highlights.
 * Each one loads the first time a block in that language appears.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language'

const legacy = (p: StreamParser<unknown>) => new LanguageSupport(StreamLanguage.define(p))

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: 'JavaScript', alias: ['js', 'javascript', 'mjs', 'cjs', 'node'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript()) }),
  LanguageDescription.of({ name: 'JSX', alias: ['jsx'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })) }),
  LanguageDescription.of({ name: 'TypeScript', alias: ['ts', 'typescript'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })) }),
  LanguageDescription.of({ name: 'TSX', alias: ['tsx'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })) }),
  LanguageDescription.of({ name: 'JSON', alias: ['json', 'json5', 'jsonc'], load: () => import('@codemirror/lang-json').then((m) => m.json()) }),
  LanguageDescription.of({ name: 'YAML', alias: ['yaml', 'yml'], load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) }),
  LanguageDescription.of({ name: 'TOML', alias: ['toml'], load: () => import('@codemirror/legacy-modes/mode/toml').then((m) => legacy(m.toml)) }),
  LanguageDescription.of({ name: 'Shell', alias: ['bash', 'sh', 'shell', 'zsh', 'shellscript', 'console'], load: () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(m.shell)) }),
  LanguageDescription.of({ name: 'Python', alias: ['py', 'python', 'python3'], load: () => import('@codemirror/lang-python').then((m) => m.python()) }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'htm', 'xhtml', 'svg', 'xml'], load: () => import('@codemirror/lang-html').then((m) => m.html()) }),
  LanguageDescription.of({ name: 'CSS', alias: ['css', 'scss', 'less'], load: () => import('@codemirror/lang-css').then((m) => m.css()) }),
  LanguageDescription.of({ name: 'Go', alias: ['go', 'golang'], load: () => import('@codemirror/lang-go').then((m) => m.go()) }),
  LanguageDescription.of({ name: 'Rust', alias: ['rs', 'rust'], load: () => import('@codemirror/lang-rust').then((m) => m.rust()) }),
  LanguageDescription.of({ name: 'SQL', alias: ['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'], load: () => import('@codemirror/lang-sql').then((m) => m.sql()) }),
  LanguageDescription.of({ name: 'Java', alias: ['java'], load: () => import('@codemirror/lang-java').then((m) => m.java()) }),
  LanguageDescription.of({ name: 'C', alias: ['c', 'h'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) }),
  LanguageDescription.of({ name: 'C++', alias: ['cpp', 'c++', 'cc', 'cxx', 'hpp'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) }),
  LanguageDescription.of({ name: 'PHP', alias: ['php'], load: () => import('@codemirror/lang-php').then((m) => m.php()) }),
  LanguageDescription.of({ name: 'Ruby', alias: ['rb', 'ruby'], load: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => legacy(m.ruby)) }),
  LanguageDescription.of({ name: 'Diff', alias: ['diff', 'patch'], load: () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(m.diff)) }),
  LanguageDescription.of({ name: 'Markdown', alias: ['md', 'markdown'], load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()) }),
]
