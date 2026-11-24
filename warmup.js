// warmup.js — a small synthetic site that exercises every code path in
// solve.js: all front-matter keys (valid, refused, draft), every
// Markdown block and inline construct, every template node kind (var,
// raw, for, if, else, include, nested includes).
//
// The driver runs this site a few times before the real cases so the
// JIT has the hot functions compiled when the real builds start. It is
// fixed synthetic data, written for this entry: its output is discarded
// and nothing from it is carried into any case, so the answers depend
// only on the cases' own inputs.

const TEMPLATES = {
  head: '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n{% include "meta" %}\n<title>{% if page %}{{ page.title }} | {% endif %}{% if tag %}{{ tag.name }} | {% endif %}{{ site.title }}</title>\n<link rel="stylesheet" href="{{ site.base_url }}/assets/style.css">\n</head>\n<body class="site">\n',
  meta: '<meta name="generator" content="warmup">\n',
  header: '<header><nav><a href="{{ site.base_url }}/">Home</a></nav></header>\n',
  footer: '<footer><p>{{ site.title }}</p><p>{% for t in tags %}{{ t.name }} {% endfor %}</p></footer>\n</body>\n</html>\n',
  card: '<article class="card">\n<h2><a href="{{ p.url }}">{{ p.title }}</a></h2>\n<p class="meta"><time datetime="{{ p.date }}">{{ p.date_long }}</time> · {{ p.reading_minutes }} min</p>\n{% if p.summary %}\n<p class="summary">{{ p.summary }}</p>\n{% else %}\n<div class="excerpt">{{{ p.excerpt }}}</div>\n{% endif %}\n{% include "tag-list" %}\n</article>\n',
  'tag-list': '{% if p.tags %}<ul>{% for t in p.tags %}<li>{% if t.url %}<a href="{{ t.url }}">{{ t.name }}</a>{% else %}{{ t.name }}{% endif %}</li>{% endfor %}</ul>{% endif %}\n',
  toc: '{% if page.toc %}<nav class="toc"><ol>{% for h in page.toc %}<li><a href="#{{ h.id }}">{{{ h.html }}}</a></li>{% endfor %}</ol></nav>{% endif %}\n',
  pager: '<nav class="pager">{% if pager.newer_url %}<a href="{{ pager.newer_url }}">Newer</a>{% endif %}<span>{{ pager.number }} / {{ pager.total }}</span>{% if pager.older_url %}<a href="{{ pager.older_url }}">Older</a>{% endif %}</nav>\n',
  strip: '<aside class="strip"><p>Strip note with {{ site.title }} and a loop:</p><ul>{% for t in tags %}<li>{{ t.name }} ({{ t.count }})</li>{% endfor %}</ul></aside>\n',
  post: '{% include "head" %}\n{% include "header" %}\n<div class="post">\n<article>\n<h1>{{ page.title }}</h1>\n{% if page.date %}<p class="meta"><time datetime="{{ page.date }}">{{ page.date_long }}</time> · {{ page.reading_minutes }} min read</p>{% endif %}\n{% if page.tags %}\n<ul class="tags">\n{% for t in page.tags %}\n<li>{% if t.url %}<a href="{{ t.url }}">{{ t.name }}</a>{% else %}{{ t.name }}{% endif %}</li>\n{% endfor %}\n</ul>\n{% endif %}\n{% include "toc" %}\n{{{ page.content }}}\n</article>\n<nav>{% if page.newer %}<a href="{{ page.newer.url }}">&larr; {{ page.newer.title }}</a>{% endif %}{% if page.older %}<a href="{{ page.older.url }}">{{ page.older.title }} &rarr;</a>{% endif %}</nav>\n{% include "strip" %}\n</div>\n{% include "footer" %}\n',
  page: '{% include "head" %}\n{% include "header" %}\n<div class="page">\n<h1>{{ page.title }}</h1>\n{% include "toc" %}\n{{{ page.content }}}\n{% if page.tags %}\n<ul class="tags">\n{% for t in page.tags %}\n<li>{{ t.name }}</li>\n{% endfor %}\n</ul>\n{% endif %}\n{% include "strip" %}\n</div>\n{% include "footer" %}\n',
  index: '{% include "head" %}\n{% include "header" %}\n<div class="index">\n{% for p in posts %}\n{% include "card" %}\n{% endfor %}\n{% if not posts %}\n<p>Nothing here yet.</p>\n{% endif %}\n{% include "pager" %}\n</div>\n{% include "footer" %}\n',
  tag: '{% include "head" %}\n{% include "header" %}\n<div class="tag">\n<h1>{{ tag.name }} <small>{{ tag.count }} posts</small></h1>\n{% for p in tag.posts %}\n{% include "card" %}\n{% endfor %}\n</div>\n{% include "footer" %}\n',
  tags: '{% include "head" %}\n{% include "header" %}\n<div class="tags-index">\n<ul>\n{% for t in tags %}\n<li><a href="{{ t.url }}">{{ t.name }}</a> <span>{{ t.count }}</span></li>\n{% endfor %}\n</ul>\n</div>\n{% include "footer" %}\n',
};

// One rich body covering every Markdown construct the renderer knows.
const RICH_BODY = [
  '# Warmup Heading One',
  '',
  'A first paragraph with **strong text**, *emphasis*, `code span`, an \\*escaped star\\*, and a [relative link](guide.md) plus [an anchor](#frag) and [a scheme link](https://example.com/x) and [a broken one](nope.md).',
  '',
  '## Second Level With `code` & <html> chars',
  '',
  'Another paragraph, longer, with more words to count for reading time: one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.',
  '',
  '### Third level heading',
  '',
  '#### Fourth level heading here',
  '',
  '```js',
  'const x = 1 < 2 && 3 > 2;',
  'console.log("hello & goodbye");',
  '```',
  '',
  '```',
  'plain fence without language',
  'second line of it',
  '```',
  '',
  '---',
  '',
  '> A quoted line here.',
  '> Another quoted line with **bold** inside.',
  '>',
  '> A third after an empty quote line.',
  '',
  '- bullet one with a [link](posts/first-post.md)',
  '- bullet two',
  '  continued line of bullet two',
  '- bullet three',
  '',
  '1. first ordered item',
  '2. second ordered item',
  '3. third ordered item',
  '',
  '7. ordered starting at seven',
  '8. next one',
  '',
  '***',
  '',
  'A trailing paragraph with a [fragment link](guide.md#section) and [parent link](../index.md) and `code` and **strong with *nested* emphasis** inside it.',
  '',
].join('\n');

function postFile(path, date, title, tags, extra) {
  return {
    path,
    content: `---\ntitle: ${title}\ndate: ${date}\ntags: [${tags}]${extra ?? ''}\n---\n${RICH_BODY}\n`,
  };
}

const FILES = [
  postFile('posts/first-post.md', '2026-01-05', 'First Post', 'Alpha, Beta'),
  postFile('posts/second-post.md', '2026-01-04', 'Second Post', 'Beta, Gamma'),
  postFile('posts/third-post.md', '2026-01-04', 'Third Post', 'alpha, Delta'),
  postFile('posts/fourth-post.md', '2026-01-03', 'Fourth Post', 'Gamma'),
  postFile('posts/fifth-post.md', '2026-01-02', 'Fifth Post', 'Delta, Epsilon'),
  postFile('posts/sixth-post.md', '2026-01-01', 'Sixth Post', 'Epsilon'),
  // A slug collision: same title as the first post, different date.
  postFile('posts/first-post-again.md', '2026-01-06', 'First Post', 'Alpha'),
  // A page with an explicit slug and summary.
  {
    path: 'guide.md',
    content: `---\ntitle: Guide Page\nslug: guide-page\nsummary: "A \\"quoted\\" summary."\n---\n${RICH_BODY}\n`,
  },
  {
    path: 'about/index.md',
    content: `---\ntitle: About This Site\nlayout: page\ntags: [Alpha, Zeta]\n---\n${RICH_BODY}\n`,
  },
  // A draft (dropped), a post with no date (refused), a source under
  // tags/ (refused), a bad front matter (refused), a missing layout
  // (refused), and a page whose layout is the post template.
  {
    path: 'posts/draft-post.md',
    content: '---\ntitle: Draft Post\ndate: 2026-01-07\ndraft: true\n---\nBody.\n',
  },
  {
    path: 'posts/no-date.md',
    content: '---\ntitle: No Date Post\n---\nBody.\n',
  },
  {
    path: 'tags/stray.md',
    content: '---\ntitle: Stray Tag Page\n---\nBody.\n',
  },
  {
    path: 'broken.md',
    content: '---\ntitle: Broken\nunknown: 1\n---\nBody.\n',
  },
  {
    path: 'no-layout.md',
    content: '---\ntitle: No Layout\nlayout: missing-template\n---\nBody.\n',
  },
  {
    path: 'notes.md',
    content: `---\ntitle: Notes\nlayout: post\n---\n${RICH_BODY}\n`,
  },
  { path: 'assets/style.css', content: 'body { color: #111; }\n' },
  { path: 'assets/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n' },
  // A static file whose path a built page takes (shadowed).
  { path: 'guide-page/index.html', content: '<p>shadowed</p>\n' },
];

export const WARMUP_INPUT = {
  site: { title: 'Warmup Site', base_url: 'https://warmup.example', per_page: 3, recent: 2 },
  templates: TEMPLATES,
  files: FILES,
};
