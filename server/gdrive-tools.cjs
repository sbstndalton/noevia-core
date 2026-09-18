'use strict';
// The Google Drive toolbox: seven tools over the calling account's own Drive connection
// (drive-accounts.cjs). Offered to a chat only when that account is connected, and each tool
// is further gated by the account's tool policy (tool-policy.cjs). Descriptions stay short
// because every tool definition is re-sent on every turn.
const { driveFiles } = require('./gdrive-files.cjs');

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const ID = { fileId: { type: 'string', description: 'Drive file id from a search or list result' } };

const TOOLS = [
  fn('drive_search_files', 'Search the user\'s Google Drive (files noevia created or was given) by name or text.', { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25 } }, ['query']),
  fn('drive_read_file', 'Read a text file, Google Doc, Sheet (as CSV) or Slides deck from Google Drive.', ID, ['fileId']),
  fn('drive_get_metadata', 'Get a Google Drive file\'s name, type, size, dates and link.', ID, ['fileId']),
  fn('drive_list_recent', 'List the most recently changed files in Google Drive.', { limit: { type: 'integer', minimum: 1, maximum: 25 } }),
  fn('drive_create_file', 'Create a new text file in Google Drive.', { name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string', description: 'text/plain (default), text/markdown, text/csv or application/json' } }, ['name', 'content']),
  fn('drive_update_file', 'Replace the content of an existing text file in Google Drive.', { ...ID, content: { type: 'string' } }, ['fileId', 'content']),
  fn('drive_trash_file', 'Move a Google Drive file to the trash (recoverable for 30 days).', ID, ['fileId']),
];
const READS = ['drive_search_files', 'drive_read_file', 'drive_get_metadata', 'drive_list_recent'];
// How Settings names each tool, in the order it lists them.
const LABELS = {
  drive_search_files: 'Search files', drive_read_file: 'Read file content', drive_get_metadata: 'Get file metadata', drive_list_recent: 'List recent files',
  drive_create_file: 'Create file', drive_update_file: 'Update file', drive_trash_file: 'Trash file',
};

const line = (f) => `- ${f.name} (id ${f.id}) · ${f.mimeType || 'file'}${f.size ? ` · ${f.size} bytes` : ''}${f.modifiedTime ? ` · changed ${f.modifiedTime}` : ''}`;

function createDriveTools({ accounts, cap = 8000 }) {
  const box = {
    id: 'gdrive', label: 'Google Drive', source: 'builtin',
    description: 'Search, read and write files in your connected Google Drive (only files noevia created or was given).',
    tools: TOOLS, reads: READS,
  };
  const names = new Set(TOOLS.map((t) => t.function.name));
  const connected = (user) => { try { return accounts.forUser(user).drive.state().state === 'connected'; } catch { return false; } };

  async function execute(user, name, args) {
    let files;
    try {
      const { drive } = accounts.forUser(user);
      if (drive.state().state !== 'connected') return 'ERROR: Google Drive is not connected for this account. Connect it in Settings → Connectors.';
      files = driveFiles(drive);
      switch (name) {
        case 'drive_search_files': { const r = await files.search(args); return r.length ? `Found ${r.length}:\n${r.map(line).join('\n')}` : 'No matching files. noevia only sees files it created or was given in this Drive.'; }
        case 'drive_list_recent': { const r = await files.recent(args); return r.length ? r.map(line).join('\n') : 'No files yet. noevia only sees files it created or was given in this Drive.'; }
        case 'drive_get_metadata': { const f = await files.metadata(args); return `${line(f)}${f.webViewLink ? `\nLink: ${f.webViewLink}` : ''}`; }
        case 'drive_read_file': { const r = await files.read(args); const text = r.text.slice(0, cap); return `${r.meta.name}:\n${text}${r.truncated || r.text.length > cap ? '\n[truncated]' : ''}`; }
        case 'drive_create_file': { const f = await files.create(args); return `Created ${f.name} (id ${f.id})${f.webViewLink ? `: ${f.webViewLink}` : ''}`; }
        case 'drive_update_file': { const f = await files.update(args); return `Updated ${f.name} (id ${f.id}).`; }
        case 'drive_trash_file': { const f = await files.trash(args); return `Moved ${f.name} to the Drive trash.`; }
        default: return `ERROR: unknown Drive tool ${name}`;
      }
    } catch (error) {
      return `ERROR: ${error.publicMessage || 'Google Drive could not be reached.'}`;
    }
  }

  return { box, names, reads: new Set(READS), labels: LABELS, connected, execute };
}

module.exports = { createDriveTools, LABELS, READS };
