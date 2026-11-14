const test = require('node:test'), assert = require('node:assert/strict');
const { cleanSearchQuery, cleanSearchArgs } = require('./search-query.cjs');

// #1523: the request wrapper is taken off a search query; the question itself is what is searched.
test('#1523: a leading colon and "Search the web" wrapper are removed from the query', () => {
  assert.equal(cleanSearchQuery(': the latest stable version of the Rust compiler? Cite the source'), 'the latest stable version of the Rust compiler');
  assert.equal(cleanSearchQuery('Search the web: latest stable Node.js LTS'), 'latest stable Node.js LTS');
  assert.equal(cleanSearchQuery('  web search - current EUR to NOK rate  '), 'current EUR to NOK rate');
});

test('#1523: a citation instruction at the start or end of the query is removed, the question kept', () => {
  assert.equal(cleanSearchQuery('Cite the sources: rust 1.99 release date'), 'rust 1.99 release date');
  assert.equal(cleanSearchQuery('rust 1.99 release date. And cite your sources for each claim.'), 'rust 1.99 release date');
  assert.equal(cleanSearchQuery('how do I cite a paper in APA style'), 'how do I cite a paper in APA style', 'a question about citing is not an instruction');
});

test('#1523: a clean query and a query that would be emptied are returned unchanged', () => {
  assert.equal(cleanSearchQuery('today\'s EUR to NOK exchange rate'), 'today\'s EUR to NOK exchange rate');
  assert.equal(cleanSearchQuery('Search the web:'), 'Search the web:', 'nothing left to search: keep what the model wrote');
  assert.equal(cleanSearchQuery(42), 42);
});

test('#1523: only a search tool\'s string query is cleaned; other arguments and tools are untouched', () => {
  const raw = JSON.stringify({ query: ': latest Rust version. Cite the source', max_results: 5 });
  assert.equal(JSON.parse(cleanSearchArgs('tavily_search', raw)).query, 'latest Rust version');
  assert.equal(JSON.parse(cleanSearchArgs('tavily_search', raw)).max_results, 5, 'other arguments survive');
  assert.equal(cleanSearchArgs('nc_webdav_read_file', raw), raw, 'a non-search tool is never rewritten');
  assert.equal(cleanSearchArgs('tavily_search', '{"query":": not json'), '{"query":": not json', 'malformed arguments are returned as they arrived');
  assert.equal(cleanSearchArgs('tavily_search', '{"query":["a"]}'), '{"query":["a"]}', 'a non-string query is left alone');
  assert.equal(cleanSearchArgs('tavily_search', '{"query":"clean query"}'), '{"query":"clean query"}', 'an unchanged query keeps the original bytes');
});

test('#2545: arguments nested past the stack go on unchanged instead of throwing', () => {
  const deep = (n) => `${'['.repeat(n)}1${']'.repeat(n)}`;
  // The cleaned form, written without JSON.stringify of the nested value (the query is the first key).
  const cleaned = (raw, query) => raw.replace(JSON.stringify(query), JSON.stringify(cleanSearchQuery(query)));
  const raw = `{"query":"Search the web: QA stack","x":${deep(10000)}}`;
  // An engine whose JSON.stringify runs out of stack gives the arguments back as they came; one that can write them
  // gives the cleaned form. Never a throw.
  const out = cleanSearchArgs('qa_web_search', raw);
  assert.ok(out === raw || out === cleaned(raw, 'Search the web: QA stack'), out.slice(0, 80));
  const shallow = `{"query":"Search the web: QA nested","x":${deep(50)}}`;
  assert.notEqual(cleaned(shallow, 'Search the web: QA nested'), shallow);
  assert.equal(cleanSearchArgs('qa_web_search', shallow), cleaned(shallow, 'Search the web: QA nested'), 'a nesting that fits is still cleaned');
});
