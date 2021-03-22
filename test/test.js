const assert = require('assert');

// mock chrome namespace
global.chrome = {};
// run background.js
const {Router, tryMatchRoute} = require('../extension/background');

(async () => {
  const tabRoute = await Router['/tabs/by-id/#TAB_ID'].readdir();
  assert(['.', '..', 'url.txt', 'title.txt', 'text.txt']
    .every(file => tabRoute.entries.includes(file)));

  assert.deepEqual(await Router['/'].readdir(),
                   { entries: ['.', '..', 'windows', 'extensions', 'tabs', 'runtime'] });
  assert.deepEqual(await Router['/tabs'].readdir(),
                   { entries: ['.', '..', 'create',
                               'by-id', 'by-title', 'last-focused'] });

  assert.deepEqual(tryMatchRoute('/'), [Router['/'], {}]);

  assert.deepEqual(tryMatchRoute('/tabs/by-id/10/url.txt'),
                   [Router['/tabs/by-id/#TAB_ID/url.txt'], {tabId: 10}]);
})();
