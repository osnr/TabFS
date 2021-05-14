const assert = require('assert');

// mock chrome namespace
global.window = global;
global.chrome = {};
// run background.js
const {Routes, tryMatchRoute} = require('../extension/background');

function readdir(path) {
  return Routes['/tabs/by-id/#TAB_ID'].readdir({path});
}

(async () => {
  const tabReaddir = await readdir('/tabs/by-id/#TAB_ID');
  assert(['.', '..', 'url.txt', 'title.txt', 'text.txt']
    .every(file => tabReaddir.entries.includes(file)));

  assert.deepEqual(await Routes['/'].readdir(),
                   { entries: ['.', '..', 'windows', 'extensions', 'tabs', 'runtime'] });
  assert.deepEqual(await Routes['/tabs'].readdir(),
                   { entries: ['.', '..', 'create',
                               'by-title', 'last-focused', 'by-id'] });

  assert.deepEqual(tryMatchRoute('/'), [Routes['/'], {}]);

  assert.deepEqual(tryMatchRoute('/tabs/by-id/10/url.txt'),
                   [Routes['/tabs/by-id/#TAB_ID/url.txt'], {tabId: 10}]);
})();
