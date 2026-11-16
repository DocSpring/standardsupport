// Builds the site into dist/: one page with the spec (../spec/README.md) and the adopters list (../ADOPTERS.md)
// rendered into it, plus the spec as Markdown for agents.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const src = new URL('./src/', import.meta.url)
const dist = new URL('./dist/', import.meta.url)
const read = (name) => readFile(new URL(name, src), 'utf8')
const repo = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

const fill = (page, marker, value) => {
  if (!page.includes(marker)) throw new Error(`Marker ${marker} is missing from the page`)
  return page.replace(marker, () => value)
}

// Renders Markdown for a place inside the page: headings move down by `shift` levels and get ids, and tables scroll
// sideways on a phone instead of stretching the page.
function render(markdown, { shift }) {
  const tokens = marked.lexer(markdown, { gfm: true })
  const seen = new Set()
  marked.walkTokens(tokens, (token) => {
    if (token.type === 'heading') token.depth = Math.min(6, token.depth + shift)
  })
  return marked
    .parser(tokens)
    .replace(/<h([2-6])>(.*?)<\/h\1>/g, (_, level, inner) => {
      let id = inner.replace(/<[^>]+>/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      while (seen.has(id)) id += '-2'
      seen.add(id)
      return `<h${level} id="${id}">${inner}</h${level}>`
    })
    .replaceAll('<table>', '<div class="table-scroll"><table>')
    .replaceAll('</table>', '</table></div>')
}

// Everything after the first heading and before the next "## " heading.
function firstSection(markdown) {
  const body = markdown.split('\n').slice(1).join('\n')
  const next = body.search(/^## /m)
  return next === -1 ? body : body.slice(0, next)
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const spec = await repo('spec/README.md')
// The page has its own title, so the spec's first heading goes and the rest sit one level down.
const specBody = spec.split('\n').slice(1).join('\n')

let page = await read('index.html')
page = fill(page, '<!--HEAD-->', await read('_head.html'))
page = fill(page, '<!--SPEC-->', render(specBody, { shift: 1 }))
page = fill(page, '<!--ADOPTERS-->', render(firstSection(await repo('ADOPTERS.md')), { shift: 1 }))

// Where the discussion is happening. The links don't exist until the posts do, so each line appears once its URL
// is filled in (src/links.json).
const links = JSON.parse(await read('links.json'))
const feedback = [
  links.hacker_news && `<li>On Hacker News: <a href="${links.hacker_news}">reply in the thread</a></li>`,
  links.x && `<li>On X: <a href="${links.x}">reply to the post</a></li>`,
]
  .filter(Boolean)
  .join('\n          ')
page = fill(page, '<!--FEEDBACK-->', feedback)

await writeFile(new URL('index.html', dist), page)

// The whole page as Markdown, for agents: made from the built page so the two can't drift apart. The theme switch
// and the on-page links are left out, and links within the site become full URLs.
const main = page.slice(page.indexOf('<main'), page.indexOf('</main>'))
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.use(gfm)
// A rule, not turndown.remove(): its built-in image rule would otherwise win.
turndown.addRule('html-only', {
  filter: (node) =>
    node.nodeName === 'NAV' ||
    node.nodeName === 'IMG' ||
    node.classList?.contains('theme') ||
    node.hasAttribute?.('data-html-only'),
  replacement: () => '',
})
const pageMarkdown = turndown
  .turndown(main)
  .replace(/\]\(\/(?!\/)/g, '](https://standardsupport.dev/')
  .replace(/\]\(#/g, '](https://standardsupport.dev/#')
await writeFile(new URL('index.md', dist), `${pageMarkdown}\n`)
await writeFile(new URL('spec.md', dist), spec)
await writeFile(new URL('404.html', dist), fill(await read('404.html'), '<!--HEAD-->', await read('_head.html')))
for (const file of ['styles.css', 'favicon.svg', 'og.png', 'llms.txt', 'CNAME']) await cp(new URL(file, src), new URL(file, dist))
await cp(new URL('fonts/', src), new URL('fonts/', dist), { recursive: true })

console.log('Built site/dist')
