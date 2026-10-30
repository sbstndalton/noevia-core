'use strict';
// A fetched page's text without its scripts, navigation, tags and cookie lines. Kiwix reads pages through this; it was
// research-sources.cjs's until deep research moved to the Rust front (noevia-rs crates/research-core sources.rs keeps
// the same rules, pinned there against these answers).
function stripBoilerplate(text) {
  return String(text)
    .replace(/<(script|style|nav|footer|header|aside|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n').replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l && !/^(cookie|accept all|subscribe|sign in|log in|share this|skip to content)\b/i.test(l))
    .join('\n');
}

module.exports = { stripBoilerplate };
