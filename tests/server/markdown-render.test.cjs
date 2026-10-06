// #388/#389/#390: MarkdownPreview (apps/web/src/components/DiaryModal.tsx), loaded through Vite's
// SSR pipeline (same technique as message-actions-render.test.cjs and customise-i18n-render.test.cjs)
// so JSX and the import graph resolve exactly as in the app, then rendered to static markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function withSsr(run) {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '../..'),
    server: { middlewareMode: true },
    appType: 'custom',
    plugins: [(await import('@vitejs/plugin-react')).default()],
  });
  global.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
  global.document = { documentElement: { dataset: {} } };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.navigator = { language: 'en-GB', languages: ['en-GB'], clipboard: { writeText: () => Promise.resolve() } };
  try {
    await run(server);
  } finally {
    delete global.window; delete global.document; delete global.localStorage; delete global.navigator;
    await server.close();
  }
}

async function renderMarkdown(server, text, props = {}) {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { MarkdownPreview } = await server.ssrLoadModule('/src/components/DiaryModal.tsx');
  return renderToStaticMarkup(React.createElement(MarkdownPreview, { text, ...props }));
}

test('#388: all six heading levels render as distinguishable headings, not two colliding on <h4> and two not rendering at all', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, [
      '# Level1 heading', '## Level2 heading', '### Level3 heading',
      '#### Level4 heading', '##### Level5 heading', '###### Level6 heading',
    ].join('\n'));
    assert.match(html, /<h2>Level1 heading<\/h2>/);
    assert.match(html, /<h3>Level2 heading<\/h3>/);
    assert.match(html, /<h4>Level3 heading<\/h4>/);
    assert.match(html, /<h5>Level4 heading<\/h5>/, 'level 4 must no longer share <h4> with level 3');
    assert.match(html, /<h6[^>]*>Level5 heading<\/h6>/, 'level 5 must render as a heading, not leak "#####" as text');
    assert.match(html, /<h6 class="md-h6-2">Level6 heading<\/h6>/, 'level 6 gets its own modifier so it stays visually below level 5');
    assert.doesNotMatch(html, /#####/, 'no literal hash marks should reach the page');
  });
});

test('#389: two consecutive blockquote lines merge into a single <blockquote>, not two separately-bordered boxes', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '> Quote line one\n> Quote line two');
    const boxes = [...html.matchAll(/<blockquote>/g)];
    assert.equal(boxes.length, 1, 'expected exactly one <blockquote> for the whole quoted passage');
    assert.match(html, /<blockquote>Quote line one<br\/>Quote line two<\/blockquote>/);
  });
});

test('#389: a blank line still separates two distinct quotes into two boxes', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '> First quote\n\n> Second quote');
    const boxes = [...html.matchAll(/<blockquote>/g)];
    assert.equal(boxes.length, 2);
  });
});

test('#390: a data: image (nothing to fetch) renders as a real <img> immediately', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '![pic](data:image/png;base64,iVBORw0KGgo=)');
    assert.match(html, /<img class="md-image" src="data:image\/png;base64,iVBORw0KGgo=" alt="pic"/);
  });
});

test('#390: a safe https image never auto-loads, and never becomes an <img> even on request — the server CSP (img-src \'self\' data:) would block it; it opens as a real link in a new tab instead', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '![real image](https://picsum.photos/40)');
    assert.doesNotMatch(html, /<img\b/, 'must never be a live <img> src — the CSP blocks it and this renderer must not pretend otherwise');
    assert.doesNotMatch(html, /!real image|!<a/, 'the old bug leaked a literal "!" in front of a plain link');
    assert.match(html, /<a href="https:\/\/picsum\.photos\/40" target="_blank" rel="noopener noreferrer nofollow" class="md-image-chip" aria-label="Open image: real image from picsum\.photos — opens in a new tab">/);
    assert.match(html, />real image</, 'the alt text is visible on the chip');
    assert.match(html, />picsum\.photos ·/, 'the host is visible before the reader decides to open it');
  });
});

test('#390: an image with no alt text still gets a sensible chip label instead of an empty one', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '![](https://example.com/x.png)');
    assert.match(html, /aria-label="Open image: Image from example\.com — opens in a new tab"/);
  });
});

test('#390 sanitisation regression: a javascript: image source is never rendered live, exactly like an unsafe link', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '![x](javascript:alert(1))');
    assert.doesNotMatch(html, /<img\b/);
    assert.doesNotMatch(html, /<a\b/);
    assert.doesNotMatch(html, /javascript:alert\(1\)"/, 'the scheme must never end up in a live src/href attribute');
  });
});

test('sanitisation regression: existing link handling is untouched — a safe https link still renders <a>, an unsafe scheme still falls back to plain text', async () => {
  await withSsr(async (server) => {
    const safe = await renderMarkdown(server, '[docs](https://example.com/docs)');
    assert.match(safe, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer nofollow">docs<\/a>/);
    const unsafe = await renderMarkdown(server, '[click me](javascript:alert(1))');
    assert.doesNotMatch(unsafe, /<a\b/);
    assert.match(unsafe, /click me \(javascript:alert\(1\)\)/);
  });
});

test('#390: the server CSP this decision depends on is still img-src \'self\' data: — if that ever loosens, MarkdownImage\'s "remote can never be an <img>" reasoning needs re-checking, not silent staleness', () => {
  const fs = require('node:fs');
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '../../server/index.cjs'), 'utf8');
  const csp = serverSrc.match(/Content-Security-Policy'\s*,\s*"([^"]+)"/);
  assert.ok(csp, 'could not find the CSP header to check');
  assert.match(csp[1], /img-src 'self' data:/);
});

test('sanitisation regression: raw HTML in a reply is still never interpreted', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '<img src=x onerror=alert(1)>');
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

test('#431: a flat bulleted list renders as a real <ul> of <li>, not one <p class="md-bullet"> per line', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '- Item A\n- Item B\n- Item C');
    assert.doesNotMatch(html, /md-bullet/, 'the old flat-paragraph rendering must be gone');
    assert.match(html, /<ul class="md-list"><li>Item A<\/li><li>Item B<\/li><li>Item C<\/li><\/ul>/);
  });
});

test('#431: nested bullets become a real nested <ul> inside the parent <li>, not a flatter list with padding', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '- Item A\n  - Sub item A1\n  - Sub item A2\n- Item B');
    const outer = [...html.matchAll(/<ul class="md-list">/g)];
    assert.equal(outer.length, 2, 'one outer list, one nested list');
    assert.match(html, /<li>Item A<ul class="md-list"><li>Sub item A1<\/li><li>Sub item A2<\/li><\/ul><\/li><li>Item B<\/li>/);
  });
});

test('#431: an ordered list renders as a real <ol> and keeps the model\'s own starting number', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '5. First\n6. Second');
    assert.match(html, /<ol class="md-list" start="5"><li>First<\/li><li>Second<\/li><\/ol>/);
  });
});

test('#431: a nested ordered list under a bulleted item nests correctly and keeps its own start number', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '1. First\n2. Second\n   1. Nested second');
    assert.match(html, /<ol class="md-list" start="1"><li>First<\/li><li>Second<ol class="md-list" start="1"><li>Nested second<\/li><\/ol><\/li><\/ol>/);
  });
});

test('#431: a task list keeps checkbox state as a real, disabled checkbox — checked for "[x]", unchecked for "[ ]"', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '- [ ] Not done yet\n- [x] Already done');
    assert.match(html, /<li class="md-task"><label class="md-task-label"><input type="checkbox" class="md-task-box" disabled="" readOnly=""\/>Not done yet<\/label><\/li>/);
    assert.match(html, /<li class="md-task md-task-done"><label class="md-task-label"><input type="checkbox" class="md-task-box" disabled="" readOnly="" checked=""\/>Already done<\/label><\/li>/);
  });
});

test('#431: a marker-type change at the same indent starts a new list instead of mixing bullets and numbers in one', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '- A bullet\n1. Then a number');
    const lists = [...html.matchAll(/<(ul|ol) class="md-list"/g)].map((m) => m[1]);
    assert.deepEqual(lists, ['ul', 'ol'], 'two separate lists, not one mixed list');
  });
});

test('#431: a list still streaming (no closing content on its last line) renders without crashing, and grows in place', async () => {
  await withSsr(async (server) => {
    const partial = await renderMarkdown(server, '- Item A\n- Item B is still str');
    assert.match(partial, /<li>Item B is still str<\/li><\/ul>/, 'the still-streaming last item renders whatever text has arrived so far');
    const grown = await renderMarkdown(server, '- Item A\n- Item B is still streaming in');
    assert.match(grown, /<li>Item B is still streaming in<\/li><\/ul>/);
  });
});

test('#431: a list correctly hands control back to the rest of the renderer — a paragraph before and after a list, and a heading right after it, all still render', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, 'Intro paragraph.\n- Item A\n- Item B\n## Heading after\nOutro paragraph.');
    assert.match(html, /<p>Intro paragraph\.<\/p>/);
    assert.match(html, /<ul class="md-list"><li>Item A<\/li><li>Item B<\/li><\/ul>/);
    assert.match(html, /<h3>Heading after<\/h3>/);
    assert.match(html, /<p>Outro paragraph\.<\/p>/);
  });
});

test('#431: the Copy action still copies raw Markdown, not the rendered list HTML (#356)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/components/ChatView.tsx'), 'utf8');
  // The copy handler must read the message's own raw `content` (the Markdown source this renderer
  // consumes), never anything read back off the rendered DOM — the same guarantee #356 already
  // established, now re-checked so #431's rewrite of the list branches did not disturb it.
  assert.match(src, /navigator\.clipboard\?\.writeText\(content\)/, 'Copy must still hand the raw message content to the clipboard, never the rendered list HTML');
});

// #835: the Diary sidecar (#803/#830) escapes structure-looking lines inside saved prose. The
// preview must show the original characters as plain text and never interpret them as HTML.
test('#835: an escaped heading line renders as plain text without the backslash, not as a heading', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '\\### Key points\n\\# Top\n\\###### Deep\n\\###');
    assert.match(html, /<p>### Key points<\/p>/);
    assert.match(html, /<p># Top<\/p>/);
    assert.match(html, /<p>###### Deep<\/p>/);
    assert.match(html, /<p>###<\/p>/);
    assert.doesNotMatch(html, /<h[1-6]/);
    assert.doesNotMatch(html, /\\/, 'no backslash may reach the page');
  });
});

test('#835: escaped role labels render as literal asterisks (not bold), and a later ** on the line cannot pair with them', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '\\*\\*Me:** hello\n\\*\\*Assistant:** use **this** now\n\\*\\*Claude:** a **b');
    assert.match(html, /<p>\*\*Me:\*\* hello<\/p>/);
    assert.match(html, /<p>\*\*Assistant:\*\* use <strong>this<\/strong> now<\/p>/);
    assert.match(html, /<p>\*\*Claude:\*\* a \*\*b<\/p>/);
    assert.doesNotMatch(html, /\\/);
  });
});

test('#835: an escaped xid opener shows as literal <!-- text, never as HTML or a stripped comment', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, 'Echoed <\\!-- xid:abc123 --> in prose');
    assert.match(html, /<p>Echoed &lt;!-- xid:abc123 --&gt; in prose<\/p>/);
    assert.doesNotMatch(html, /<!--/, 'no real HTML comment may be emitted');
    const wiki = await renderMarkdown(server, '<\\!-- xid:z -->', { wikiLink: () => undefined });
    assert.match(wiki, /<p>&lt;!-- xid:z --&gt;<\/p>/);
  });
});

test('#835: unescaped headings, role labels and comments render exactly as before', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '### Real heading\n**Me:** hello\n<!-- xid:1 -->\nvalue \\* kept\n\\#hashtag');
    assert.match(html, /<h4>Real heading<\/h4>/);
    assert.match(html, /<p><strong>Me:<\/strong> hello<\/p>/);
    assert.doesNotMatch(html, /xid/, 'a real xid comment stays hidden');
    assert.match(html, /<p>value \\\* kept<\/p>/, 'other backslashes are untouched');
    assert.match(html, /<p>\\#hashtag<\/p>/, 'a backslash before # with no space is not a heading escape');
  });
});

test('#835: the sidecar escapes a first-line role label after the real label; the escaped label stays literal and does not pair with later bold', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '**Me:** \\*\\*Assistant:** use **this** now');
    assert.match(html, /<p><strong>Me:<\/strong> \*\*Assistant:\*\* use <strong>this<\/strong> now<\/p>/);
    const wiki = await renderMarkdown(server, '**Assistant:** \\*\\*Me:** x **y**', { wikiLink: () => undefined });
    assert.match(wiki, /<p><strong>Assistant:<\/strong> \*\*Me:\*\* x <strong>y<\/strong><\/p>/);
  });
});

test('#835: an escaped heading with CRLF line endings is still plain text', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '\\### Key points\r\n\\###\r\nafter');
    assert.doesNotMatch(html, /<h[1-6]/);
    assert.match(html, /<p>### Key points\r?<\/p>/);
    assert.match(html, /<p>###\r?<\/p>/);
    assert.doesNotMatch(html, /\\/);
  });
});

test('#835: an escaped xid opener inside bold or italic text loses its backslash, but a code span is shown verbatim', async () => {
  await withSsr(async (server) => {
    const html = await renderMarkdown(server, '**a <\\!-- b** and *c <\\!-- d* and `e <\\!-- f`');
    assert.match(html, /<strong>a &lt;!-- b<\/strong>/);
    assert.match(html, /<em>c &lt;!-- d<\/em>/);
    assert.match(html, /<code>e &lt;\\!-- f<\/code>/);
  });
});
