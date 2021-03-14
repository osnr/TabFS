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

  // Open flags
  O_TRUNC: 01000,
}

class UnixError extends Error {
  constructor(error) { super(); this.name = "UnixError"; this.error = error; }
}

function pathComponent(path, i) {
  const components = path.split('/');
  return components[i >= 0 ? i : components.length + i];
}
const sanitize = (function() {
  // from https://github.com/parshap/node-sanitize-filename/blob/209c39b914c8eb48ee27bcbde64b2c7822fdf3de/index.js

  // I've added ' ' to the list of illegal characters. it's a
  // decision whether we want to allow spaces in filenames... I think
  // they're annoying, so I'm sanitizing them out for now.
  var illegalRe = /[\/\?<>\\:\*\|" ]/g;
  var controlRe = /[\x00-\x1f\x80-\x9f]/g;
  var reservedRe = /^\.+$/;
  var windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  var windowsTrailingRe = /[\. ]+$/;

  function sanitize(input, replacement) {
    if (typeof input !== 'string') {
      throw new Error('Input must be string');
    }
    var sanitized = input
      .replace(illegalRe, replacement)
      .replace(controlRe, replacement)
      .replace(reservedRe, replacement)
      .replace(windowsReservedRe, replacement)
      .replace(windowsTrailingRe, replacement);
    return sanitized.slice(0, 200);
  }
  return input => sanitize(input, '_');
})();

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
  setObjectForHandle(handle, object) { this.store[handle] = object; },
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
  async open({path, flags}) {
    const data = !(flags & unix.O_TRUNC) ? await getData(path) : "";
    return { fh: Cache.storeObject(toUtf8Array(data)) };
  },
  async read({path, fh, size, offset}) {
    return { buf: String.fromCharCode(...Cache.getObjectForHandle(fh).slice(offset, offset + size)) }
  },
  async write({path, fh, offset, buf}) {
    let arr = Cache.getObjectForHandle(fh);
    const bufarr = stringToUtf8Array(buf);
    if (offset + bufarr.length > arr.length) {
      const newArr = new Uint8Array(offset + bufarr.length);
      newArr.set(arr.slice(0, Math.min(offset, arr.length)));
      arr = newArr;
      Cache.setObjectForHandle(fh, arr);
    }
    arr.set(bufarr, offset);
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
    if (size !== arr.length) {
      const newArr = new Uint8Array(size);
      newArr.set(arr.slice(0, Math.min(size, arr.length)));
      arr = newArr;
    }
    await setData(path, utf8ArrayToString(arr)); return {};
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
  router["/tabs/by-id/*/source.html"] = fromScript(`document.body.innerHTML`);

  // echo true > mnt/tabs/by-id/1644/active
  // cat mnt/tabs/by-id/1644/active
  router["/tabs/by-id/*/active"] = withTab(tab => JSON.stringify(tab.active) + '\n',
                                           // WEIRD: we do startsWith because you might end up with buf
                                           // being "truee" (if it was "false", then someone wrote "true")
                                           buf => ({ active: buf.startsWith("true") }));
})();
(function() {
  const evals = {};
  router["/tabs/by-id/*/evals"] = {
    async readdir({path}) {
      const tabId = parseInt(pathComponent(path, -2));
      return { entries: [".", "..",
                         ...Object.keys(evals[tabId] || {}),
                         ...Object.keys(evals[tabId] || {}).map(f => f + '.result')] };
    },
    getattr() {
      return {
        st_mode: unix.S_IFDIR | 0777, // writable so you can create/rm evals
        st_nlink: 3,
        st_size: 0,
      };
    },
  };
  router["/tabs/by-id/*/evals/*"] = {
    // NOTE: eval runs in extension's content script, not in original page JS context
    async mknod({path, mode}) {
      const [tabId, name] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      evals[tabId] = evals[tabId] || {};
      evals[tabId][name] = { code: '' };
      return {};
    },
    async unlink({path}) {
      const [tabId, name] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      delete evals[tabId][name]; // TODO: also delete evals[tabId] if empty
      return {};
    },

    ...defineFile(async path => {
      const [tabId, filename] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      const name = filename.replace(/\.result$/, '');
      if (!evals[tabId] || !(name in evals[tabId])) { throw new UnixError(unix.ENOENT); }

      if (filename.endsWith('.result')) {
        return evals[tabId][name].result || '';
      } else {
        return evals[tabId][name].code;
      }
    }, async (path, buf) => {
      const [tabId, name] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      if (name.endsWith('.result')) {
        // FIXME

      } else {
        evals[tabId][name].code = buf;
        evals[tabId][name].result = JSON.stringify((await browser.tabs.executeScript(tabId, {code: buf}))[0]) + '\n';
      }
    })
  };
})();
(function() {
  const watches = {};
  router["/tabs/by-id/*/watches"] = {
    async readdir({path}) {
      const tabId = parseInt(pathComponent(path, -2));
      return { entries: [".", "..", ...Object.keys(watches[tabId] || [])] };
    },
    getattr() {
      return {
        st_mode: unix.S_IFDIR | 0777, // writable so you can create/rm watches
        st_nlink: 3,
        st_size: 0,
      };
    },
  };
  router["/tabs/by-id/*/watches/*"] = {
    // NOTE: eval runs in extension's content script, not in original page JS context
    async mknod({path, mode}) {
      const [tabId, expr] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      watches[tabId] = watches[tabId] || {};
      watches[tabId][expr] = async function() {
        return (await browser.tabs.executeScript(tabId, {code: expr}))[0];
      };
      return {};
    },
    async unlink({path}) {
      const [tabId, expr] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      delete watches[tabId][expr]; // TODO: also delete watches[tabId] if empty
      return {};
    },

    ...defineFile(async path => {
      const [tabId, expr] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];
      if (!watches[tabId] || !(expr in watches[tabId])) { throw new UnixError(unix.ENOENT); }
      return JSON.stringify(await watches[tabId][expr]()) + '\n';
    }, () => {
      // setData handler -- only providing this so that getattr reports
      // that the file is writable, so it can be deleted without annoying prompt.
      throw new UnixError(unix.EPERM);
    })
  };
})();

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
      return { entries: [".", "..", ...frameTree.resources.map(r => sanitize(String(r.url)))] };
    }
  };
  router["/tabs/by-id/*/debugger/resources/*"] = defineFile(async path => {
    const [tabId, suffix] = [parseInt(pathComponent(path, -4)), pathComponent(path, -1)];
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");

    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    for (let resource of frameTree.resources) {
      const resourceSuffix = sanitize(String(resource.url));
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
            .map(params => params.scriptId + "_" + sanitize(params.url));
      return { entries: [".", "..", ...scriptFileNames] };
    }
  };
  function pathScriptInfo(tabId, path) {
    const [scriptId, ...rest] = pathComponent(path, -1).split("_");
    const scriptInfo = TabManager.scriptsForTab[tabId][scriptId];
    if (!scriptInfo || sanitize(scriptInfo.url) !== rest.join("_")) {
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

router["/tabs/by-id/*/inputs"] = {
  async readdir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    // TODO: assign new IDs to inputs without them?
    const code = `Array.from(document.querySelectorAll('textarea, input[type=text]')).map(e => e.id).filter(id => id)`
    const ids = (await browser.tabs.executeScript(tabId, {code}))[0];
    return { entries: [".", "..", ...ids.map(id => `${id}.txt`)] };
  }
};
router["/tabs/by-id/*/inputs/*"] = defineFile(async path => {
  const [tabId, inputId] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1).slice(0, -4)];
  const code = `document.getElementById('${inputId}').value`;
  const inputValue = (await browser.tabs.executeScript(tabId, {code}))[0];
  if (inputValue === null) { throw new UnixError(unix.ENOENT); } /* FIXME: hack to deal with if inputId isn't valid */
  return inputValue;
}, async (path, buf) => {
  const [tabId, inputId] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1).slice(0, -4)];
  const code = `document.getElementById('${inputId}').value = unescape('${escape(buf)}')`;
  await browser.tabs.executeScript(tabId, {code});
});

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
    return { entries: [".", "..", ...tabs.map(tab => sanitize(String(tab.title)) + "_" + String(tab.id))] };
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
(function() {
  const withWindow = (readHandler, writeHandler) => defineFile(async path => {
    const windowId = parseInt(pathComponent(path, -2));
    const window = await browser.windows.get(windowId);
    return readHandler(window);

  }, writeHandler ? async (path, buf) => {
    const windowId = parseInt(pathComponent(path, -2));
    await browser.windows.update(windowId, writeHandler(buf));
  } : undefined);

  router["/windows/*/focused"] = withWindow(window => JSON.stringify(window.focused) + '\n',
                                            buf => ({ focused: buf.startsWith('true') }));
})();
router["/windows/*/visible-tab.png"] = { ...defineFile(async path => {
  // screen capture is a window thing and not a tab thing because you
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
          st_mode: unix.S_IFREG | ((router[key].read && 0444) | (router[key].write && 0222)),
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
  // Safari / Safari extension app API forces you to adopt their
  // {name, userInfo} structure for the request.
  if (req.name === 'ToSafari') req = req.userInfo;

  if (req.buf) req.buf = atob(req.buf);
  console.log('req', req);

  let response = { op: req.op, error: unix.EIO };
  let didTimeout = false, timeout = setTimeout(() => {
    // timeout is very useful because some operations just hang
    // (like trying to take a screenshot, until the tab is focused)
    didTimeout = true; console.error('timeout');
    port.postMessage({ id: req.id, op: req.op, error: unix.ETIMEDOUT });
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
    response.id = req.id;
    port.postMessage(response);
  }
};

function tryConnect() {
  // Safari is very weird -- it has this native app that we have to talk to,
  // so we poke that app to wake it up, get it to start the TabFS process
  // and boot a WebSocket, then connect to it.
  // Is there a better way to do this?
  if (chrome.runtime.getURL('/').startsWith('safari-web-extension://')) { // Safari-only
    chrome.runtime.sendNativeMessage('com.rsnous.tabfs', {op: 'safari_did_connect'}, resp => {
      console.log(resp);

      let socket;
      function connectSocket(checkAfterTime) {
        socket = new WebSocket('ws://localhost:9991');
        socket.addEventListener('message', event => {
          onMessage(JSON.parse(event.data));
        });

        port = { postMessage(message) {
          socket.send(JSON.stringify(message));
        } };

        setTimeout(() => {
          if (socket.readyState !== 1) {
            console.log('ws connection failed, retrying in', checkAfterTime);
            connectSocket(checkAfterTime * 2);
          }
        }, checkAfterTime);
      }
      connectSocket(200);
    });
    return;
  }
  
  port = chrome.runtime.connectNative('com.rsnous.tabfs');
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {console.log('disconnect', p)});
}

if (!TESTING) {
  tryConnect();
}
