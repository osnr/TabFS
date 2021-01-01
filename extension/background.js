const TESTING = (typeof chrome === 'undefined');

const unix = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  ENOTSUP: 45,
  ETIMEDOUT: 110, // FIXME: not on macOS (?)

  // Unix file types
  S_IFMT: 0170000, // type of file mask
  S_IFIFO: 010000, // named pipe (fifo)
  S_IFCHR: 020000, // character special
  S_IFDIR: 040000, // directory
  S_IFBLK: 060000, // block special
  S_IFREG: 0100000, // regular
  S_IFLNK: 0120000, // symbolic link
  S_IFSOCK: 0140000, // socket
}

class UnixError extends Error {
  constructor(error) { super(); this.name = "UnixError"; this.error = error; }
}

function pathComponent(path, i) {
  const components = path.split('/');
  return components[i >= 0 ? i : components.length + i];
}
function sanitize(s) { return s.replace(/[^A-Za-z0-9_\-\.]/gm, '_'); }
const stringToUtf8Array = (function() {
  const encoder = new TextEncoder("utf-8");
  return str => encoder.encode(str);
})();
const utf8ArrayToString = (function() {
  const decoder = new TextDecoder("utf-8");
  return utf8 => decoder.decode(utf8);
})();


async function attachDebugger(tabId) {
  return new Promise((resolve, reject) => chrome.debugger.attach({tabId}, "1.3", () => {
    if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); }
    else { resolve(); }
  }));
}
async function detachDebugger(tabId) {
  return new Promise((resolve, reject) => chrome.debugger.detach({tabId}, () => {
    if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); }
    else { resolve(); }
  }));
}
const TabManager = (function() {
  if (TESTING) return;
  if (chrome.debugger) chrome.debugger.onEvent.addListener((source, method, params) => {
    console.log(source, method, params);
    if (method === "Page.frameStartedLoading") {
      // we're gonna assume we're always plugged into both Page and Debugger.
      TabManager.scriptsForTab[source.tabId] = {};

    } else if (method === "Debugger.scriptParsed") {
      TabManager.scriptsForTab[source.tabId] = TabManager.scriptsForTab[source.tabId] || {};
      TabManager.scriptsForTab[source.tabId][params.scriptId] = params;
    }
  });

  return {
    scriptsForTab: {},
    debugTab: async function(tabId) {
      // meant to be higher-level wrapper for raw attach/detach
      // TODO: could we remember if we're already attached? idk if it's worth it
      try { await attachDebugger(tabId); }
      catch (e) {
        if (e.message.indexOf('Another debugger is already attached') !== -1) {
          await detachDebugger(tabId);
          await attachDebugger(tabId);
        }
      }
      // TODO: detach automatically? some kind of reference counting thing?
    },
    enableDomainForTab: async function(tabId, domain) {
      // TODO: could we remember if we're already enabled? idk if it's worth it
      if (domain === 'Debugger') { TabManager.scriptsForTab[tabId] = {}; }
      await sendDebuggerCommand(tabId, `${domain}.enable`, {});
    }
  };
})();
function sendDebuggerCommand(tabId, method, commandParams) {
  return new Promise((resolve, reject) =>
    chrome.debugger.sendCommand({tabId}, method, commandParams, result => {
      if (result) { resolve(result); } else { reject(chrome.runtime.lastError); }
    })
  );
}

const router = {};

const Cache = {
  // used when you open a file to cache the content we got from the
  // browser until you close that file. (so we can respond to
  // individual chunk read() and write() requests without doing a
  // whole new conversation with the browser and regenerating the
  // content -- important for taking a screenshot, for instance)
  store: {}, nextHandle: 0,
  storeObject(object) {
    const handle = ++this.nextHandle;
    this.store[handle] = object;
    return handle;
  },
  getObjectForHandle(handle) { return this.store[handle]; },
  removeObjectForHandle(handle) { delete this.store[handle]; }
};
function toUtf8Array(stringOrArray) {
  if (typeof stringOrArray == 'string') { return stringToUtf8Array(stringOrArray); }
  else { return stringOrArray; }
}
const defineFile = (getData, setData) => ({
  // Generates a full set of file operations (so clients can read and
  // write sections of the file, stat it to get its size and see it
  // show up in ls, etc), given getData and setData functions that
  // define the contents of the entire file.

  // getData: (path: String) -> Promise<contentsOfFile: String|Uint8Array>
  // setData [optional]: (path: String, newContentsOfFile: String) -> Promise<>

  // You can override file operations (like `truncate` or `getattr`)
  // in the returned set if you want different behavior from what's
  // defined here.

  async getattr({path}) {
    return {
      st_mode: unix.S_IFREG | 0444 | (setData ? 0222 : 0),
      st_nlink: 1,
      // you'll want to override this if getData() is slow, because
      // getattr() gets called a lot more cavalierly than open().
      st_size: toUtf8Array(await getData(path)).length
    };
  },

  // We call getData() once when the file is opened, then cache that
  // data for all subsequent reads from that application.
  async open({path}) { return { fh: Cache.storeObject(toUtf8Array(await getData(path))) }; },
  async read({path, fh, size, offset}) {
    return { buf: String.fromCharCode(...Cache.getObjectForHandle(fh).slice(offset, offset + size)) }
  },
  async write({path, fh, offset, buf}) {
    let arr = Cache.getObjectForHandle(fh);
    const bufarr = stringToUtf8Array(buf);
    if (offset + bufarr.length > arr.length) {
      const newArr = new Uint8Array(offset + bufarr.length);
      newArr.set(arr); arr = newArr;
    }
    for (let i = 0; i < bufarr.length; i++) { arr[offset + i] = bufarr[i]; }
    // I guess caller should override write() if they want to actually
    // patch and not just re-set the whole string (for example,
    // if they want to hot-reload just one function the user modified)
    await setData(path, utf8ArrayToString(arr)); return { size: bufarr.length };
  },
  async release({fh}) { Cache.removeObjectForHandle(fh); return {}; },

  async truncate({path, size}) {
    // TODO: weird case if they truncate while the file is open
    // (but `echo hi > foo.txt`, the main thing I care about, uses
    // O_TRUNC which thankfully doesn't do that)
    let arr = toUtf8Array(await getData(path));
    if (size > arr.length) {
      const newArr = new Uint8Array(size);
      newArr.set(arr); arr = newArr;
    }
    await setData(path, utf8ArrayToString(arr.slice(0, size))); return {};
  }
});

router["/tabs/create"] = {
  async write({path, buf}) {
    const url = buf.trim();
    await browser.tabs.create({url});
    return {size: stringToUtf8Array(buf).length};
  },
  async truncate({path, size}) { return {}; }
}

router["/tabs/by-id"] = {  
  async readdir() {
    const tabs = await browser.tabs.query({});
    return { entries: [".", "..", ...tabs.map(tab => String(tab.id))] };
  }
};
// title.txt
// url.txt
// text.txt
// TODO: document.html

// eval-in
// eval-out

// TODO: mem (?)
// TODO: cpu (?)

// TODO: dom/ ?
// TODO: globals/ ?

// TODO: archive.mhtml ?
// TODO: printed.pdf
// control

// there's a question about whether to do stuff through injected
// JavaScript or through the devtools API.

(function() {
  const withTab = (readHandler, writeHandler) => defineFile(async path => {
    const tabId = parseInt(pathComponent(path, -2));
    const tab = await browser.tabs.get(tabId);
    return readHandler(tab);

  }, writeHandler ? async (path, buf) => {
    const tabId = parseInt(pathComponent(path, -2));
    await browser.tabs.update(tabId, writeHandler(buf));
  } : undefined);
  const fromScript = code => defineFile(async path => {
    const tabId = parseInt(pathComponent(path, -2));
    return (await browser.tabs.executeScript(tabId, {code}))[0];
  });

  router["/tabs/by-id/*/url.txt"] = withTab(tab => tab.url + "\n", buf => ({ url: buf }));
  router["/tabs/by-id/*/title.txt"] = withTab(tab => tab.title + "\n");
  router["/tabs/by-id/*/text.txt"] = fromScript(`document.body.innerText`);
})();
(function() {
  let nextConsoleFh = 0; let consoleForFh = {};
  chrome.runtime.onMessage.addListener(data => {
    if (!consoleForFh[data.fh]) return;
    consoleForFh[data.fh].push(data.xs);
  });
  router["/tabs/by-id/*/console"] = {
    // this one is a bit weird. it doesn't start tracking until it's opened.
    // tail -f console
    async getattr() {
      return {
        st_mode: unix.S_IFREG | 0444,
        st_nlink: 1,
        st_size: 0 // FIXME
      };
    },
    async open({path}) {
      const tabId = parseInt(pathComponent(path, -2));
      const fh = nextConsoleFh++;
      const code = `
// runs in 'content script' context
var script = document.createElement('script');
var code = \`
  // will run both here in content script context and in
  // real Web page context (so we hook console.log for both)
  (function() {
    if (!console.__logOld) console.__logOld = console.log;
    if (!console.__logFhs) console.__logFhs = new Set();
    console.__logFhs.add(${fh});
    console.log = (...xs) => {
      console.__logOld(...xs);
      try {
        // TODO: use random event for security instead of this broadcast
        for (let fh of console.__logFhs) {
          window.postMessage({fh: ${fh}, xs: xs}, '*');
        }
      // error usually if one of xs is not serializable
      } catch (e) { console.error(e); }
    };
  })()
\`;
eval(code);
script.appendChild(document.createTextNode(code));
(document.body || document.head).appendChild(script);

window.addEventListener('message', function({data}) {
  if (data.fh !== ${fh}) return;
  // forward to the background script
  chrome.runtime.sendMessage(null, data);
});
`;
      consoleForFh[fh] = [];
      await browser.tabs.executeScript(tabId, {code});
      return {fh};
    },
    async read({path, fh, offset, size}) {
      const all = consoleForFh[fh].join('\n');
      // TODO: do this more incrementally ?
      // will probably break down if log is huge
      const buf = String.fromCharCode(...toUtf8Array(all).slice(offset, offset + size));
      return { buf };
    },
    async release({path, fh}) {
      const tabId = parseInt(pathComponent(path, -2));
      // TODO: clean up the hooks inside the contexts
      delete consoleForFh[fh];
      return {};
    }
  };
})();
router["/tabs/by-id/*/execute-script"] = {
  // note: runs in a content script, _not_ in the Web page context
  async write({path, buf}) {
    // FIXME: chunk this properly (like if they write a script in
    // multiple chunks) and only execute when ready?
    const tabId = parseInt(pathComponent(path, -2));
    await browser.tabs.executeScript(tabId, {code: buf});
    return {size: stringToUtf8Array(buf).length};
  },
  async truncate({path, size}) { return {}; }
};
// TODO: imports
// (function() {
//   const imports = {};
//   // .json - autoparse, spit back out changes in data
//   // .js
//   // .png
//   // write back modify
//   router["/tabs/by-id/*/imports"] = {
//     readdir({path}) {
      
//     }
//   };
// })();
// TODO: watches
// router["/tabs/by-id/*/watches"] = {
// };
router["/tabs/by-id/*/window"] = {
  // a symbolic link to /windows/[id for this window]
  async readlink({path}) {
    const tabId = parseInt(pathComponent(path, -2)); const tab = await browser.tabs.get(tabId);
    return { buf: "../../../windows/" + tab.windowId };
  }
};
router["/tabs/by-id/*/control"] = {
  // echo remove > mnt/tabs/by-id/1644/control
  async write({path, buf}) {
    const tabId = parseInt(pathComponent(path, -2));
    const command = buf.trim();
    // can use `discard`, `remove`, `reload`, `goForward`, `goBack`...
    // see https://developer.chrome.com/extensions/tabs
    await browser.tabs[command](tabId);
    return {size: stringToUtf8Array(buf).length};
  },
  async truncate({path, size}) { return {}; }
};

// debugger/ : debugger-API-dependent (Chrome-only)
(function() {
  if (!chrome.debugger) return;
  // possible idea: console (using Log API instead of monkey-patching)
  // resources/
  // TODO: scripts/ TODO: allow creation, eval immediately

  router["/tabs/by-id/*/debugger/resources"] = {
    async readdir({path}) {
      const tabId = parseInt(pathComponent(path, -3));
      await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");
      const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
      return { entries: [".", "..", ...frameTree.resources.map(r => sanitize(String(r.url).slice(0, 200)))] };
    }
  };
  router["/tabs/by-id/*/debugger/resources/*"] = defineFile(async path => {
    const [tabId, suffix] = [parseInt(pathComponent(path, -4)), pathComponent(path, -1)];
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");

    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    for (let resource of frameTree.resources) {
      const resourceSuffix = sanitize(String(resource.url).slice(0, 200));
      if (resourceSuffix === suffix) {
        let {base64Encoded, content} = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
          frameId: frameTree.frame.id,
          url: resource.url
        });
        if (base64Encoded) { return Uint8Array.from(atob(content), c => c.charCodeAt(0)); }
        return content;
      }
    }
    throw new UnixError(unix.ENOENT);
  });
  router["/tabs/by-id/*/debugger/scripts"] = {
    async opendir({path}) {
      const tabId = parseInt(pathComponent(path, -3));
      await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Debugger");
      return { fh: 0 };
    },
    async readdir({path}) {
      const tabId = parseInt(pathComponent(path, -3));
      // it's useful to put the ID first so the .js extension stays on
      // the end
      const scriptFileNames = Object.values(TabManager.scriptsForTab[tabId])
            .map(params => params.scriptId + "_" + sanitize(params.url).slice(0, 200));
      return { entries: [".", "..", ...scriptFileNames] };
    }
  };
  function pathScriptInfo(tabId, path) {
    const [scriptId, ...rest] = pathComponent(path, -1).split("_");
    const scriptInfo = TabManager.scriptsForTab[tabId][scriptId];
    if (!scriptInfo || sanitize(scriptInfo.url).slice(0, 200) !== rest.join("_")) {
      throw new UnixError(unix.ENOENT);
    }
    return scriptInfo;
  }
  router["/tabs/by-id/*/debugger/scripts/*"] = defineFile(async path => {
    const [tabId, suffix] = [parseInt(pathComponent(path, -4)), pathComponent(path, -1)];
    await TabManager.debugTab(tabId);
    await TabManager.enableDomainForTab(tabId, "Page");
    await TabManager.enableDomainForTab(tabId, "Debugger");

    const {scriptId} = pathScriptInfo(tabId, path);
    const {scriptSource} = await sendDebuggerCommand(tabId, "Debugger.getScriptSource", {scriptId});
    return scriptSource;

  }, async (path, buf) => {
    const [tabId, suffix] = [parseInt(pathComponent(path, -4)), pathComponent(path, -1)];
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Debugger");

    const {scriptId} = pathScriptInfo(tabId, path);
    await sendDebuggerCommand(tabId, "Debugger.setScriptSource", {scriptId, scriptSource: buf});
  });
})();

router["/tabs/by-title"] = {
  getattr() {
    return {
      st_mode: unix.S_IFDIR | 0777, // writable so you can delete tabs
      st_nlink: 3,
      st_size: 0,
    };
  },
  async readdir() {
    const tabs = await browser.tabs.query({});
    return { entries: [".", "..", ...tabs.map(tab => sanitize(String(tab.title).slice(0, 200)) + "_" + String(tab.id))] };
  }
};
router["/tabs/by-title/*"] = {
  // TODO: date
  async readlink({path}) { // a symbolic link to /tabs/by-id/[id for this tab]
    const parts = path.split("_"); const tabId = parts[parts.length - 1];
    return { buf: "../by-id/" + tabId };
  },
  async unlink({path}) { // you can delete a by-title/TAB to close that tab
    const parts = path.split("_"); const tabId = parseInt(parts[parts.length - 1]);
    await browser.tabs.remove(tabId);
    return {};
  }
};
router["/tabs/last-focused"] = {
  // a symbolic link to /tabs/by-id/[id for this tab]
  async readlink({path}) {
    const id = (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0].id;
    return { buf: "by-id/" + id };
  }
};

router["/windows"] = {
  async readdir() {
    const windows = await browser.windows.getAll();
    return { entries: [".", "..", ...windows.map(window => String(window.id))] };
  }
};
router["/windows/last-focused"] = {
  // a symbolic link to /windows/[id for this window]
  async readlink({path}) {
    const windowId = (await browser.windows.getLastFocused()).id;
    return { buf: windowId };
  }
};
router["/windows/*/visible-tab.png"] = { ...defineFile(async path => {
  // this is a window thing (rn, the _only_ window thing) because you
  // can only capture the visible tab for each window anyway; you
  // can't take a screenshot of just any arbitrary tab
  const windowId = parseInt(pathComponent(path, -2));
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, {format: 'png'});
  return Uint8Array.from(atob(dataUrl.substr(("data:image/png;base64,").length)),
                         c => c.charCodeAt(0));

}), async getattr({path}) {
  return {
    st_mode: unix.S_IFREG | 0444,
    st_nlink: 1,
    st_size: 10000000 // hard-code to 10MB for now
  };
} };


router["/extensions"] = {  
  async readdir() {
    const infos = await browser.management.getAll();
    return { entries: [".", "..", ...infos.map(info => `${sanitize(info.name)}_${info.id}`)] };
  }
};
router["/extensions/*/enabled"] = { ...defineFile(async path => {
  const parts = pathComponent(path, -2).split('_'); const extensionId = parts[parts.length - 1];
  const info = await browser.management.get(extensionId);
  return String(info.enabled) + '\n';

}, async (path, buf) => {
  const parts = pathComponent(path, -2).split('_'); const extensionId = parts[parts.length - 1];
  await browser.management.setEnabled(extensionId, buf.trim() === "true");

  // suppress truncate so it doesn't accidentally flip the state when you do, e.g., `echo true >`
}), truncate() { return {}; } };

router["/runtime/reload"] = {
  async write({path, buf}) {
    await browser.runtime.reload();
    return {size: stringToUtf8Array(buf).length};
  },
  truncate() { return {}; }
};

// Ensure that there are routes for all ancestors. This algorithm is
// probably not correct, but whatever. Basically, you need to start at
// the deepest level, fill in all the parents 1 level up that don't
// exist yet, then walk up one level at a time. It's important to go
// one level at a time so you know (for each parent) what all the
// children will be.
for (let i = 10; i >= 0; i--) {
  for (let path of Object.keys(router).filter(key => key.split("/").length === i)) {
    path = path.substr(0, path.lastIndexOf("/"));
    if (path == '') path = '/';

    if (!router[path]) {
      function depth(p) { return p === '/' ? 0 : (p.match(/\//g) || []).length; }

      // find all direct children
      let entries = Object.keys(router)
                          .filter(k => k.startsWith(path) && depth(k) === depth(path) + 1)
                          .map(k => k.substr((path === '/' ? 0 : path.length) + 1).split('/')[0]);
      entries = [".", "..", ...new Set(entries)];

      router[path] = { readdir() { return { entries }; } };
    }
  }
  // I also think it would be better to compute this stuff on the fly,
  // so you could patch more routes in at runtime, but I need to think
  // a bit about how to make that work with wildcards.
}
if (TESTING) { // I wish I could color this section with... a pink background, or something.
  const assert = require('assert');
  (async () => {
    assert.deepEqual(await router['/tabs/by-id/*'].readdir(), { entries: ['.', '..', 'url.txt', 'title.txt', 'text.txt', 'window', 'control', 'debugger'] });
    assert.deepEqual(await router['/'].readdir(), { entries: ['.', '..', 'windows', 'extensions', 'tabs', 'runtime'] });
    assert.deepEqual(await router['/tabs'].readdir(), { entries: ['.', '..', 'create', 'by-id', 'by-title', 'last-focused'] });
    
    assert.deepEqual(findRoute('/tabs/by-id/TABID/url.txt'), router['/tabs/by-id/*/url.txt']);
  })()
}


// fill in default implementations of fs ops
for (let key in router) {
  // if readdir -> directory -> add getattr, opendir, releasedir
  if (router[key].readdir) {
    router[key] = {
      getattr() { 
        return {
          st_mode: unix.S_IFDIR | 0755,
          st_nlink: 3,
          st_size: 0,
        };
      },
      opendir({path}) { return { fh: 0 }; },
      releasedir({path}) { return {}; },
      ...router[key]
    };

  } else if (router[key].readlink) {
    router[key] = {
      async getattr({path}) {
        const st_size = (await this.readlink({path})).buf.length + 1;
        return {
          st_mode: unix.S_IFLNK | 0444,
          st_nlink: 1,
          // You _must_ return correct linkee path length from getattr!
          st_size
        };
      },
      ...router[key]
    };
    
  } else if (router[key].read || router[key].write) {
    router[key] = {
      async getattr() {
        return {
          st_mode: unix.S_IFREG | ((router[key].read && 0444) || (router[key].write && 0222)),
          st_nlink: 1,
          st_size: 100 // FIXME
        };
      },
      open() {
        return { fh: 0 };
      },
      release() {
        return {};
      },
      ...router[key]
    };
  }
}

function findRoute(path) {
  let pathSegments = path.split("/");
  
  if (pathSegments[pathSegments.length - 1].startsWith("._")) {
    throw new UnixError(unix.ENOTSUP); // Apple Double file for xattrs
  }

  let routingPath = "";
  for (let segment of pathSegments) {
    if (routingPath === "/") { routingPath = ""; }

    if (router[routingPath + "/*"]) {
      routingPath += "/*";
    } else if (router[routingPath + "/" + segment]) {
      routingPath += "/" + segment;
    } else {
      throw new UnixError(unix.ENOENT);
    }
  }
  return router[routingPath];
}

let port;
async function onMessage(req) {
  if (req.buf) req.buf = atob(req.buf);
  console.log('req', req);

  let response = { op: req.op, error: unix.EIO };
  let didTimeout = false, timeout = setTimeout(() => {
    // timeout is very useful because some operations just hang
    // (like trying to take a screenshot, until the tab is focused)
    didTimeout = true; console.error('timeout');
    port.postMessage({ op: req.op, error: unix.ETIMEDOUT });
  }, 1000);

  /* console.time(req.op + ':' + req.path);*/
  try {
    response = await findRoute(req.path)[req.op](req);
    response.op = req.op;
    if (response.buf) { response.buf = btoa(response.buf); }

  } catch (e) {
    console.error(e);
    response = {
      op: req.op,
      error: e instanceof UnixError ? e.error : unix.EIO
    }
  }
  /* console.timeEnd(req.op + ':' + req.path);*/

  if (!didTimeout) {
    clearTimeout(timeout);

    console.log('resp', response);
    port.postMessage(response);
  }
};

function tryConnect() {
  port = chrome.runtime.connectNative('com.rsnous.tabfs');
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {console.log('disconnect', p)});
}

if (!TESTING) {
  tryConnect();
}
