'use strict';
// #1523: a model can copy the request wrapper around a question into the search it runs
// ("Search the web: what is the latest ... Cite the source."), leaving a leading colon and the
// citation instruction in the query. A search query is the question itself, so the wrapper is taken
// off the `query` of a search tool before the call is made or kept. Only a tool whose name says it
// searches, and only its string `query`, is changed; everything else is returned byte-for-byte.
// Never empties a query: if nothing meaningful is left, the model's own text is kept.

// Leading punctuation and quote marks: ": the latest ..." -> "the latest ...".
const LEADING_PUNCTUATION = /^[\s:;,.\-–—"'`“”‘’]+/;
// "Search the web:", "Please search the internet for", "Web search:", "Google online about".
const SEARCH_WRAPPER = /^(?:(?:please\s+)?(?:search|look\s*up|google)\s+(?:the\s+)?(?:web|internet|online)(?:\s+(?:for|about))?\s*[:,-]?|(?:web|internet)\s+search\s*[:,-])\s*/i;
// A citation instruction at the start: "Cite the sources: ...".
const CITE_LEAD = /^cite\s+(?:the\s+|your\s+|a\s+|any\s+)?(?:sources?|links?|citations?|urls?|references?)\s*[:,-]?\s*/i;
// A citation instruction at the end: "... ? Cite the source", "... and cite your sources for each claim".
const CITE_TAIL = /[\s.?!;,-]*(?:\band\s+)?(?:\bplease\s+)?\bcite\s+(?:the\s+|your\s+|a\s+|any\s+|all\s+)?(?:sources?|links?|citations?|urls?|references?)\b(?:\s+(?:for|with|in|from|to)\b[^.?!]*)?[\s.?!;,]*$/i;
const TRAILING_PUNCTUATION = /[\s.?!;,:]+$/;

/** The question a search query should carry. Returns the input unchanged when nothing is removed or
 *  when removing the wrapper would leave less than three characters. */
function cleanSearchQuery(query) {
  if (typeof query !== 'string') return query;
  let text = query.trim();
  for (let previous = null; previous !== text;) {
    previous = text;
    text = text.replace(LEADING_PUNCTUATION, '').replace(SEARCH_WRAPPER, '').replace(CITE_LEAD, '').trim();
  }
  text = text.replace(CITE_TAIL, '').replace(TRAILING_PUNCTUATION, '').trim();
  return text.length >= 3 ? text : query;
}

/** The arguments a call carries, with a search tool's `query` cleaned. Anything that is not a JSON
 *  object with a string `query` on a tool whose name says it searches is returned as it arrived. */
function cleanSearchArgs(name, rawArgs) {
  if (typeof name !== 'string' || !/search/i.test(name) || typeof rawArgs !== 'string' || !rawArgs) return rawArgs;
  let args;
  try { args = JSON.parse(rawArgs); } catch { return rawArgs; }
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.query !== 'string') return rawArgs;
  const query = cleanSearchQuery(args.query);
  if (query === args.query) return rawArgs;
  return JSON.stringify({ ...args, query });
}

module.exports = { cleanSearchQuery, cleanSearchArgs };
