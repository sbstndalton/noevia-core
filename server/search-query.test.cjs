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
