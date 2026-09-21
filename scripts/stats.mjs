// Collects contribution stats from local git history + GitHub PR search,
// then renders assets/stats-{light,dark}.svg. Reads stats.config.json (gitignored).
// Usage: node scripts/stats.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const config = JSON.parse(readFileSync(new URL('../stats.config.json', import.meta.url)))
const emails = new Set(config.emails.map((e) => e.toLowerCase()))

// Skip lockfiles, build output, vendored/generated code and anything big enough to be generated.
const IGNORED_PATH = /(^|\/)(node_modules|dist|build|public|vendor|generated|core-sdk)\/|\.d\.ts$|\.min\.|lock\.|\.lock$/
const MAX_LINES_PER_FILE_CHANGE = 5000

const LANGUAGES = {
  TypeScript: { color: '#3178c6', ext: ['ts', 'mts', 'cts'] },
  JavaScript: { color: '#f1e05a', ext: ['js', 'mjs', 'cjs'] },
  // Frameworks with their own file types are shown on their own, like GitHub does for Vue.
  React: { color: '#61dafb', ext: ['tsx', 'jsx'] },
  Vue: { color: '#41b883', ext: ['vue'] },
  SQL: { color: '#e38c00', ext: ['sql'] },
  Python: { color: '#3572a5', ext: ['py'] },
  'C#': { color: '#178600', ext: ['cs'] },
  CSS: { color: '#663399', ext: ['css', 'scss', 'sass', 'less'] },
  HTML: { color: '#e34c26', ext: ['html', 'pug'] },
  Shell: { color: '#89e051', ext: ['sh', 'bash', 'zsh'] },
  Go: { color: '#00add8', ext: ['go'] },
  Java: { color: '#b07219', ext: ['java'] },
  Swift: { color: '#f05138', ext: ['swift'] },
}
const EXT_TO_LANGUAGE = Object.fromEntries(
  Object.entries(LANGUAGES).flatMap(([name, { ext }]) => ext.map((e) => [e, name])),
)

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] })

const isExcluded = (name) => config.exclude.some((pattern) => name.includes(pattern))

function findRepos(dir, depth = 0) {
  const entries = readdirSync(dir, { withFileTypes: true })
  // Keep descending past a repo: workspaces like ~/Repos/Eatsy nest other repos inside.
  const self = entries.some((e) => e.name === '.git') ? [dir] : []
  if (depth >= 3) return self
  return self.concat(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .flatMap((e) => findRepos(join(dir, e.name), depth + 1)),
  )
}

function normalizeRepo(nameWithOwner) {
  const [owner, name] = nameWithOwner.toLowerCase().split('/')
  return `${config.ownerAliases[owner] ?? owner}/${name}`
}

function repoKey(dir) {
  try {
    const match = git(dir, 'remote', 'get-url', 'origin').trim().match(/github\.com[:/](.+?)(\.git)?$/)
    if (match) return normalizeRepo(match[1])
  } catch {}
  return `local:${relative(config.root, dir)}`
}

const repos = new Set()
const commits = new Map() // hash -> author year
const seenFileChanges = new Set()
const linesByLanguage = {}

for (const dir of findRepos(config.root)) {
  const path = relative(config.root, dir)
  const key = repoKey(dir)
  if (isExcluded(path) || isExcluded(key)) continue

  let log
  try {
    log = git(dir, 'log', '--all', '--format=C %H %ae %ad', '--date=format:%Y', '--numstat')
  } catch {
    continue // empty repo
  }

  let mine = false
  let hash = null
  for (const line of log.split('\n')) {
    if (line.startsWith('C ')) {
      const [, h, email, year] = line.split(' ')
      hash = emails.has(email.toLowerCase()) ? h : null
      if (hash) {
        commits.set(hash, year)
        mine = true
      }
      continue
    }
    if (!hash) continue
    const [added, deleted, file] = line.split('\t')
    if (!file || added === '-') continue
    // The same commit can exist in several clones/worktrees; count each file change once.
    const changeKey = `${hash}:${file}`
    if (seenFileChanges.has(changeKey)) continue
    seenFileChanges.add(changeKey)

    const lines = Number(added) + Number(deleted)
    if (lines > MAX_LINES_PER_FILE_CHANGE || IGNORED_PATH.test(file)) continue
    const language = EXT_TO_LANGUAGE[file.split('.').pop().toLowerCase()]
    if (language) linesByLanguage[language] = (linesByLanguage[language] ?? 0) + lines
  }
  if (mine) repos.add(key)
}

// PRs, including repos that are not cloned locally. Search API caps at 1000 results.
let pullRequests = 0
const pullRequestsByYear = {}
for (let page = 1; page <= 10; page++) {
  const result = JSON.parse(
    execFileSync('gh', ['api', 'search/issues', '-X', 'GET', '-f', `q=author:${config.githubUser} type:pr`, '-f', 'per_page=100', '-f', `page=${page}`], { encoding: 'utf8' }),
  )
  pullRequests = result.total_count
  for (const item of result.items) {
    const year = item.created_at.slice(0, 4)
    pullRequestsByYear[year] = (pullRequestsByYear[year] ?? 0) + 1
    const key = normalizeRepo(item.repository_url.replace(/.*\/repos\//, ''))
    if (!isExcluded(key)) repos.add(key)
  }
  if (page * 100 >= result.total_count) break
}

const totalLines = Object.values(linesByLanguage).reduce((a, b) => a + b, 0)
const ranked = Object.entries(linesByLanguage).sort((a, b) => b[1] - a[1])
const TOP = 7
const languages = ranked.slice(0, TOP).map(([name, lines]) => ({ name, color: LANGUAGES[name].color, percent: (lines / totalLines) * 100 }))
const otherLines = ranked.slice(TOP).reduce((sum, [, lines]) => sum + lines, 0)
if (otherLines) languages.push({ name: 'Other', color: '#8b949e', percent: (otherLines / totalLines) * 100 })

const commitsByYear = {}
for (const year of commits.values()) commitsByYear[year] = (commitsByYear[year] ?? 0) + 1
const years = [...new Set([...Object.keys(commitsByYear), ...Object.keys(pullRequestsByYear)])].sort()

const stats = {
  repositories: repos.size,
  commits: commits.size,
  pullRequests,
  languages,
  byYear: years.map((year) => ({ year, commits: commitsByYear[year] ?? 0, pullRequests: pullRequestsByYear[year] ?? 0 })),
  updatedAt: new Date().toISOString().slice(0, 10),
}
console.log(JSON.stringify(stats, null, 2))
if (process.argv.includes('--debug')) console.error([...repos].sort().join('\n'))

// ---------- SVG ----------

const THEMES = {
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#59636e', track: '#eaeef2' },
  dark: { bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#9198a1', track: '#21262d' },
}
const WIDTH = 840
const PAD = 32
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`

function render(theme) {
  const t = THEMES[theme]
  const tiles = [
    ['Repositories', stats.repositories],
    ['Commits', stats.commits],
    ['Pull requests', stats.pullRequests],
  ]
  const tileWidth = (WIDTH - PAD * 2) / tiles.length
  const tilesSvg = tiles
    .map(
      ([label, value], i) => `
    <g transform="translate(${PAD + i * tileWidth}, ${PAD})">
      <text y="36" font-size="36" font-weight="600" fill="${t.text}">${value.toLocaleString('en-US')}</text>
      <text y="62" font-size="14" fill="${t.muted}">${label}</text>
    </g>`,
    )
    .join('')

  const barY = 140
  const barWidth = WIDTH - PAD * 2
  let x = PAD
  const segments = languages
    .map(({ color, percent }) => {
      const w = (percent / 100) * barWidth
      const rect = `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="10" fill="${color}"/>`
      x += w
      return rect
    })
    .join('')

  const legendColumns = 4
  const legendColumnWidth = barWidth / legendColumns
  const legend = languages
    .map(({ name, color, percent }, i) => {
      const lx = PAD + (i % legendColumns) * legendColumnWidth
      const ly = barY + 40 + Math.floor(i / legendColumns) * 26
      return `
    <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${color}"/>
    <text x="${lx + 16}" y="${ly}" font-size="13" fill="${t.text}">${name} <tspan fill="${t.muted}">${percent.toFixed(1)}%</tspan></text>`
    })
    .join('')
  const legendRows = Math.ceil(languages.length / legendColumns)

  const tableY = barY + 40 + legendRows * 26 + 36
  const labelWidth = 120
  const yearWidth = (barWidth - labelWidth) / stats.byYear.length
  const cell = (value, i, y, color, weight = 400) =>
    `<text x="${PAD + labelWidth + (i + 1) * yearWidth}" y="${y}" font-size="13" font-weight="${weight}" text-anchor="end" fill="${color}">${value}</text>`
  const count = (n) => (n ? n.toLocaleString('en-US') : '–')
  const table = `
  <text x="${PAD}" y="${tableY}" font-size="14" font-weight="600" fill="${t.text}">By year</text>
  ${stats.byYear.map(({ year }, i) => cell(year, i, tableY, t.muted, 600)).join('')}
  <line x1="${PAD}" x2="${WIDTH - PAD}" y1="${tableY + 10}" y2="${tableY + 10}" stroke="${t.border}"/>
  <text x="${PAD}" y="${tableY + 32}" font-size="13" fill="${t.muted}">Commits</text>
  ${stats.byYear.map(({ commits }, i) => cell(count(commits), i, tableY + 32, t.text)).join('')}
  <text x="${PAD}" y="${tableY + 56}" font-size="13" fill="${t.muted}">Pull requests</text>
  ${stats.byYear.map(({ pullRequests }, i) => cell(count(pullRequests), i, tableY + 56, t.text)).join('')}`
  const footerY = tableY + 90
  const height = footerY + 24

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}">
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  ${tilesSvg}
  <text x="${PAD}" y="${barY - 16}" font-size="14" font-weight="600" fill="${t.text}">Languages</text>
  <clipPath id="bar"><rect x="${PAD}" y="${barY}" width="${barWidth}" height="10" rx="5"/></clipPath>
  <rect x="${PAD}" y="${barY}" width="${barWidth}" height="10" rx="5" fill="${t.track}"/>
  <g clip-path="url(#bar)">${segments}</g>
  ${legend}
  ${table}
  <text x="${PAD}" y="${footerY}" font-size="12" fill="${t.muted}">Including private work · updated ${stats.updatedAt}</text>
</svg>
`
}

for (const theme of Object.keys(THEMES)) {
  writeFileSync(new URL(`../assets/stats-${theme}.svg`, import.meta.url), render(theme))
}
