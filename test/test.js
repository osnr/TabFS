const assert = require('assert');

// mock chrome namespace
global.chrome = {};
// run background.js
const {router, findRoute} = require('../extension/background');

(async () => {
  const tabRoute = await router['/tabs/by-id/*'].readdir();
  assert(['.', '..', 'url.txt', 'title.txt', 'text.txt']
    .every(file => tabRoute.entries.includes(file)));

  assert.deepEqual(await router['/'].readdir(),
                   { entries: ['.', '..', 'windows', 'extensions', 'tabs', 'runtime'] });
  assert.deepEqual(await router['/tabs'].readdir(),
                   { entries: ['.', '..', 'create',
                               'by-id', 'by-title', 'last-focused'] });
  
  assert.deepEqual(findRoute('/tabs/by-id/TABID/url.txt'),
                   router['/tabs/by-id/*/url.txt']);
})();
