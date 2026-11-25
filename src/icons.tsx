const paths: Record<string, string> = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  paste: 'M9 4h6v3H9zM7 5.5H5.5A1.5 1.5 0 0 0 4 7v12.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V7a1.5 1.5 0 0 0-1.5-1.5H17M8 12h8M8 16h5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  auto: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18',
  print: 'M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  panel: 'M4 5h16v14H4zM14 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  pdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  code: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M10.5 12.5 8.5 14.5l2 2M13.5 12.5l2 2-2 2',
  md: 'M3 6h18v12H3zM6.5 15V9l2.5 3 2.5-3v6M16.5 9v6M14.5 13l2 2 2-2',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  rich: 'M4 6h16M4 10h10M4 14h16M4 18h8',
  chevron: 'M6 9l6 6 6-6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  filter: 'M4 5h16l-6 8v5l-4 2v-7z',
  graph: 'M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.5 6.2l8.7 1.3M6.6 7l1 10M16.6 8.8l-7.4 9',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16.5v.5',
  warning: 'M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0zM12 9.5v4M12 17v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5V8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  archive: 'M4 4h16v4H4zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  newfile: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11.5v6M9 14.5h6',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  save: 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7.5 3v5h8V3M7 21v-7h10v7',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M10 5h8M6 19h8M14 5l-4 14',
  strike: 'M4 12h16M16.5 7c-.6-1.3-2.2-2-4.4-2C9.6 5 8 6.2 8 8c0 1.5 1 2.4 2.8 3M8 16.5c.6 1.6 2.3 2.5 4.6 2.5 2.6 0 4.4-1.2 4.4-3.2 0-.8-.3-1.4-.8-1.8',
  inline: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  heading: 'M6 4v16M18 4v16M6 12h12',
  ul: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  ol: 'M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M3.8 14.6c.3-.6 1-1 1.7-1 .9 0 1.5.6 1.5 1.3 0 1.2-3 2.1-3 3.6h3',
  task: 'M3.5 4.5h5v5h-5zM3.5 14.5h5v5h-5zM12 7h9M12 17h9M4.8 17.2l1.2 1.2 2.2-2.6',
  quote: 'M5 5v14M10 8h10M10 12h10M10 16h6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  table: 'M3 5h18v14H3zM3 10h18M3 14.5h18M9 5v14M15 5v14',
  codeblock: 'M4 4h16v16H4zM9.5 9.5 7.5 12l2 2.5M14.5 9.5l2 2.5-2 2.5',
  math: 'M18 5H6l6 7-6 7h12',
  hr: 'M3 12h18M7 6.5h10M7 17.5h10',
  split: 'M3 5h18v14H3zM12 5v14',
  plus: 'M12 5v14M5 12h14',
  dot: 'M12 12h.01',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5V8',
  install:'M12 3v10M8 9l4 4 4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3',
}
export function Icon({ name }: { name: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
      {name === 'dot' && <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />}
      {name === 'auto' && <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />}
    </svg>
  )
}
