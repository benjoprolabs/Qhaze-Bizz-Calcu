// Shared settings for every test file.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// The app's address, worked out from this file's location, so the tests
// work on any computer and in any folder.
const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

// Screenshots and downloaded files go here (ignored by Git).
const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

module.exports = { APP_URL, OUTPUT_DIR };
