const test = require('node:test'), assert = require('node:assert/strict');
const { toolRouteNotes } = require('./tool-route-notes.cjs');

const ALL = ['nextcloud-files', 'gdrive', 'web-search', 'core'];

// #1520: a named connector that is off is said so, and the model is told not to search another storage in its place.
test('#1520: a Nextcloud request with Nextcloud Files off says so and forbids a Drive substitute', () => {
  const note = toolRouteNotes({ message: 'List the folders at the top of my Nextcloud files (names only).', offered: ['gdrive', 'core'], onServer: ALL });
  assert.match(note, /named Nextcloud Files, but Nextcloud Files is not available in this chat/);
  assert.match(note, /Do not use another storage's tools in its place/);
  assert.match(note, /\+ > Tools/);
  assert.doesNotMatch(note, /Answer that request with the Nextcloud Files tools/);
});

test('#1520: a named connector that is on is answered with its own tools, and every on connector names its tools', () => {
  const note = toolRouteNotes({ message: 'Use the Nextcloud Files tool (not Google Drive) to list my folders.', offered: ['nextcloud-files', 'gdrive'], onServer: ALL });
  assert.match(note, /named Nextcloud Files\. Answer that request with the Nextcloud Files tools \(nc_webdav_\*\)/);
  assert.match(note, /Connectors in this chat, and the tools that belong to each: Nextcloud Files \(nc_webdav_\* tools\); Google Drive \(drive_\* tools\)/);
});

test('#1520: a Google Drive request with Drive not connected says so, instead of a Nextcloud search answering it', () => {
  const note = toolRouteNotes({ message: 'What is in my Google Drive?', offered: ['nextcloud-files'], onServer: ALL });
  assert.match(note, /named Google Drive, but Google Drive is not available in this chat/);
  assert.match(note, /connect it under Settings > Connectors/);
});

test('#1520: a message that names no connector adds nothing to the system text', () => {
  assert.equal(toolRouteNotes({ message: 'Summarise the project plan.', offered: ['nextcloud-files'], onServer: ALL }), '');
});

// #1521: time-sensitive question with Web search off must not be answered as if the model cannot browse at all.
test('#1521: a latest-version question with Web search off says it cannot verify and suggests turning search on', () => {
  const note = toolRouteNotes({ message: 'Search the web: what is the latest stable version of the Rust compiler? Cite the source.', offered: ['core'], onServer: ALL });
  assert.match(note, /Web search is off for this chat, so you cannot check current information/);
  assert.match(note, /say that you cannot verify it right now/);
  assert.match(note, /turn Web search on under \+ > Tools/);
  assert.match(note, /Do not say that you cannot browse the internet in general/);
});

test('#1521: with Web search on, or for a question that is not time-sensitive, no web note is added', () => {
  assert.equal(toolRouteNotes({ message: 'What is the latest Rust version?', offered: ['web-search'], onServer: ALL }), '');
  assert.equal(toolRouteNotes({ message: 'How do I write a Rust enum?', offered: ['core'], onServer: ALL }), '');
});

test('#1521: when the server has no web search at all, the note says so instead of suggesting a switch', () => {
  const note = toolRouteNotes({ message: 'What is the current weather in Oslo?', offered: ['core'], onServer: ['core'] });
  assert.match(note, /Web search is not available on this server/);
  assert.doesNotMatch(note, /\+ > Tools/);
});

test('non-string or empty input is never a note', () => {
  assert.equal(toolRouteNotes({ message: undefined, offered: [], onServer: [] }), '');
  assert.equal(toolRouteNotes({ message: '', offered: null, onServer: null }), '');
});

test('#1550: in Automatic there is no list to tick, so the notes point at the connection instead of + > Tools', () => {
  const nc = toolRouteNotes({ message: 'List my Nextcloud folders', offered: ['core'], onServer: ALL, automatic: true });
  assert.match(nc, /Nextcloud Files is not available in this chat \(connect it under Settings > Connectors/);
  assert.doesNotMatch(nc, /\+ > Tools/);
  const web = toolRouteNotes({ message: 'What is the latest Rust version?', offered: ['core'], onServer: ALL, automatic: true });
  assert.match(web, /Web search could not be used for this message/);
  assert.doesNotMatch(web, /\+ > Tools/);
  assert.equal(toolRouteNotes({ message: 'What is the latest Rust version?', offered: ['web-search'], onServer: ALL, automatic: true }), '');
});
