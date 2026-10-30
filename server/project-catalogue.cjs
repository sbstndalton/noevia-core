'use strict';
// sbstndalton/noevia#2191 round 2: what the Rust front's project create needs of this process's
// runtime state, published as UI_DATA_DIR/project-catalogue.json (noevia-rs crates/server-projects
// lifecycle.rs `Catalogue`; since round 9 also its configuration and instruction-skill routes). MCP discovery runs here, so the toolbox ids a project may select
// (allToolboxes() without the connector boxes, which is what sanitizeToolboxes accepts) are known
// here only; the default list and the project icons (contracts/project-icons.json) ride along so
// both processes validate one list.
//
// This process is the file's only writer; the front reads it on each create. `publish` writes only
// when the content changed (an atomic rename, so the front never reads half a file), and is called
// at startup and at each request start, so a toolbox discovered later reaches the next create.
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'project-catalogue.json';

// `known` (#2191 round 9) is every toolbox id the server offers, the connector boxes included
// (allToolboxes()): the instruction skills the front lists and resolves judge a skill's `requires`
// against it, while `selectable` is what a project may pick (sanitizeToolboxes).
function catalogueOf({ selectable, defaults, icons, known = selectable }) {
  return { version: 1, selectable: [...selectable], defaults: [...defaults], icons: [...icons], known: [...known] };
}

function createCataloguePublisher({ dataDir, current, warn = console.warn }) {
  let last = null;
  function publish() {
    let text;
    try { text = JSON.stringify(catalogueOf(current())); } catch (err) { warn(`[projects] toolbox catalogue unavailable: ${err.message}`); return false; }
    if (text === last) return false;
    const file = path.join(dataDir, FILE);
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
      last = text;
      return true;
    } catch (err) {
      warn(`[projects] could not publish the toolbox catalogue: ${err.message}`);
      return false;
    }
  }
  return { publish, file: path.join(dataDir, FILE) };
}

module.exports = { FILE, catalogueOf, createCataloguePublisher };
