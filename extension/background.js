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

  // getData: (req: Request U Vars) -> Promise<contentsOfFile: String|Uint8Array>
  // setData [optional]: (req: Request U Vars, newContentsOfFile: String) -> Promise<>

  // You can override file operations (like `truncate` or `getattr`)
  // in the returned set if you want different behavior from what's
  // defined here.

  async getattr(req) {
    return {
      st_mode: unix.S_IFREG | 0444 | (setData ? 0222 : 0),
      st_nlink: 1,
      // you'll want to override this if getData() is slow, because
      // getattr() gets called a lot more cavalierly than open().
      st_size: toUtf8Array(await getData(req)).length
    };
  },

  // We call getData() once when the file is opened, then cache that
  // data for all subsequent reads from that application.
  async open(req) {
    const data = !(req.flags & unix.O_TRUNC) ? await getData(req) : "";
    return { fh: Cache.storeObject(toUtf8Array(data)) };
  },
  async read({fh, size, offset}) {
    return { buf: String.fromCharCode(...Cache.getObjectForHandle(fh).slice(offset, offset + size)) }
  },
  async write(req) {
    const {fh, offset, buf} = req;
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
    await setData(req, utf8ArrayToString(arr)); return { size: bufarr.length };
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
  async write({buf}) {
    const url = buf.trim();
    await browser.tabs.create({url});
    return {size: stringToUtf8Array(buf).length};
  },
  async truncate() { return {}; }
};

router["/tabs/by-id"] = {  
  async readdir() {
    const tabs = await browser.tabs.query({});
    return { entries: [".", "..", ...tabs.map(tab => String(tab.id))] };
  }
};

(function() {
  const withTab = (readHandler, writeHandler) => defineFile(async ({tabId}) => {
    const tab = await browser.tabs.get(tabId);
    return readHandler(tab);

  }, writeHandler ? async ({tabId}, buf) => {
    await browser.tabs.update(tabId, writeHandler(buf));
  } : undefined);

  const fromScript = code => defineFile(async ({tabId}) => {
    return (await browser.tabs.executeScript(tabId, {code}))[0];
  });

  router["/tabs/by-id/#TAB_ID/url.txt"] = withTab(tab => tab.url + "\n", buf => ({ url: buf }));
  router["/tabs/by-id/#TAB_ID/title.txt"] = withTab(tab => tab.title + "\n");
  router["/tabs/by-id/#TAB_ID/text.txt"] = fromScript(`document.body.innerText`);
  router["/tabs/by-id/#TAB_ID/body.html"] = fromScript(`document.body.innerHTML`);

  // echo true > mnt/tabs/by-id/1644/active
  // cat mnt/tabs/by-id/1644/active
  router["/tabs/by-id/#TAB_ID/active"] = withTab(tab => JSON.stringify(tab.active) + '\n',
                                                 // WEIRD: we do startsWith because you might end up with buf
                                                 // being "truee" (if it was "false", then someone wrote "true")
                                                 buf => ({ active: buf.startsWith("true") }));
})();
(function() {
  const evals = {};
  router["/tabs/by-id/#TAB_ID/evals"] = {
    async readdir({path, tabId}) {
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
  router["/tabs/by-id/#TAB_ID/evals/:FILENAME"] = {
    // NOTE: eval runs in extension's content script, not in original page JS context
    async mknod({tabId, filename, mode}) {
      evals[tabId] = evals[tabId] || {};
      evals[tabId][filename] = { code: '' };
      return {};
    },
    async unlink({tabId, filename}) {
      delete evals[tabId][filename]; // TODO: also delete evals[tabId] if empty
      return {};
    },

    ...defineFile(async ({tabId, filename}) => {
      const name = filename.replace(/\.result$/, '');
      if (!evals[tabId] || !(name in evals[tabId])) { throw new UnixError(unix.ENOENT); }

      if (filename.endsWith('.result')) {
        return evals[tabId][name].result || '';
      } else {
        return evals[tabId][name].code;
      }
    }, async ({tabId, filename}, buf) => {
      if (filename.endsWith('.result')) {
        // FIXME: case where they try to write to .result file

      } else {
        const name = filename;
        evals[tabId][name].code = buf;
        evals[tabId][name].result = JSON.stringify((await browser.tabs.executeScript(tabId, {code: buf}))[0]) + '\n';
      }
    })
  };
})();
(function() {
  const watches = {};
  router["/tabs/by-id/#TAB_ID/watches"] = {
    async readdir({tabId}) {
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
  router["/tabs/by-id/#TAB_ID/watches/:EXPR"] = {
    // NOTE: eval runs in extension's content script, not in original page JS context
    async mknod({tabId, expr, mode}) {
      watches[tabId] = watches[tabId] || {};
      watches[tabId][expr] = async function() {
        return (await browser.tabs.executeScript(tabId, {code: expr}))[0];
      };
      return {};
    },
    async unlink({tabId, expr}) {
      delete watches[tabId][expr]; // TODO: also delete watches[tabId] if empty
      return {};
    },

    ...defineFile(async ({tabId, expr}) => {
      if (!watches[tabId] || !(expr in watches[tabId])) { throw new UnixError(unix.ENOENT); }
      return JSON.stringify(await watches[tabId][expr]()) + '\n';

    }, () => {
      // setData handler -- only providing this so that getattr reports
      // that the file is writable, so it can be deleted without annoying prompt.
      throw new UnixError(unix.EPERM);
    })
  };
})();

router["/tabs/by-id/#TAB_ID/window"] = {
  // a symbolic link to /windows/[id for this window]
  async readlink({tabId}) {
    const tab = await browser.tabs.get(tabId);
    return { buf: "../../../windows/" + tab.windowId };
  }
};
router["/tabs/by-id/#TAB_ID/control"] = {
  // echo remove > mnt/tabs/by-id/1644/control
  async write({tabId, buf}) {
    const command = buf.trim();
    // can use `discard`, `remove`, `reload`, `goForward`, `goBack`...
    // see https://developer.chrome.com/extensions/tabs
    await browser.tabs[command](tabId);
    return {size: stringToUtf8Array(buf).length};
  },
  async truncate({size}) { return {}; }
};
// debugger/ : debugger-API-dependent (Chrome-only)
(function() {
  if (!chrome.debugger) return;

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

  // possible idea: console (using Log API instead of monkey-patching)
  // resources/
  // TODO: scripts/ TODO: allow creation, eval immediately

  router["/tabs/by-id/#TAB_ID/debugger/resources"] = {
    async readdir({tabId}) {
      await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");
      const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
      return { entries: [".", "..", ...frameTree.resources.map(r => sanitize(String(r.url)))] };
    }
  };
  router["/tabs/by-id/#TAB_ID/debugger/resources/:SUFFIX"] = defineFile(async ({path, tabId}) => {
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
  router["/tabs/by-id/#TAB_ID/debugger/scripts"] = {
    async opendir({tabId}) {
      await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Debugger");
      return { fh: 0 };
    },
    async readdir({tabId}) {
      // it's useful to put the ID first in the script filenames, so
      // the .js extension stays on the end
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
  router["/tabs/by-id/#TAB_ID/debugger/scripts/:SUFFIX"] = defineFile(async ({path, tabId, suffix}) => {
    await TabManager.debugTab(tabId);
    await TabManager.enableDomainForTab(tabId, "Page");
    await TabManager.enableDomainForTab(tabId, "Debugger");

    const {scriptId} = pathScriptInfo(tabId, path);
    const {scriptSource} = await sendDebuggerCommand(tabId, "Debugger.getScriptSource", {scriptId});
    return scriptSource;

  }, async ({path, tabId, suffix}, buf) => {
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Debugger");

    const {scriptId} = pathScriptInfo(tabId, path);
    await sendDebuggerCommand(tabId, "Debugger.setScriptSource", {scriptId, scriptSource: buf});
  });
})();

router["/tabs/by-id/#TAB_ID/inputs"] = {
  async readdir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    // TODO: assign new IDs to inputs without them?
    const code = `Array.from(document.querySelectorAll('textarea, input[type=text]'))
                    .map(e => e.id).filter(id => id)`;
    const ids = (await browser.tabs.executeScript(tabId, {code}))[0];
    return { entries: [".", "..", ...ids.map(id => `${id}.txt`)] };
  }
};
router["/tabs/by-id/#TAB_ID/inputs/:INPUT_ID.txt"] = defineFile(async ({path, tabId, inputId}) => {
  const code = `document.getElementById('${inputId}').value`;
  const inputValue = (await browser.tabs.executeScript(tabId, {code}))[0];
  if (inputValue === null) { throw new UnixError(unix.ENOENT); } /* FIXME: hack to deal with if inputId isn't valid */
  return inputValue;

}, async ({path, tabId, inputId}, buf) => {
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
    return { entries: [".", "..", ...tabs.map(tab => sanitize(String(tab.title)) + "." + String(tab.id))] };
  }
};
router["/tabs/by-title/:TAB_TITLE.#TAB_ID"] = {
  // TODO: date
  async readlink({tabId}) { // a symbolic link to /tabs/by-id/[id for this tab]
    return { buf: "../by-id/" + tabId };
  },
  async unlink({tabId}) { // you can delete a by-title/TAB to close that tab
    await browser.tabs.remove(tabId);
    return {};
  }
};
router["/tabs/last-focused"] = {
  // a symbolic link to /tabs/by-id/[id for this tab]
  async readlink() {
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
  async readlink() {
    const windowId = (await browser.windows.getLastFocused()).id;
    return { buf: windowId };
  }
};
(function() {
  const withWindow = (readHandler, writeHandler) => defineFile(async ({windowId}) => {
    const window = await browser.windows.get(windowId);
    return readHandler(window);

  }, writeHandler ? async ({windowId}, buf) => {
    await browser.windows.update(windowId, writeHandler(buf));
  } : undefined);

  router["/windows/#WINDOW_ID/focused"] =
    withWindow(window => JSON.stringify(window.focused) + '\n',
               buf => ({ focused: buf.startsWith('true') }));
})();
router["/windows/#WINDOW_ID/visible-tab.png"] = { ...defineFile(async ({windowId}) => {
  // screen capture is a window thing and not a tab thing because you
  // can only capture the visible tab for each window anyway; you
  // can't take a screenshot of just any arbitrary tab
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, {format: 'png'});
  return Uint8Array.from(atob(dataUrl.substr(("data:image/png;base64,").length)),
                         c => c.charCodeAt(0));

}), async getattr() {
  return {
    st_mode: unix.S_IFREG | 0444,
    st_nlink: 1,
    st_size: 10000000 // hard-code to 10MB for now
  };
} };


router["/extensions"] = {  
  async readdir() {
    const infos = await browser.management.getAll();
    return { entries: [".", "..", ...infos.map(info => `${sanitize(info.name)}.${info.id}`)] };
  }
};
router["/extensions/:EXTENSION_TITLE.:EXTENSION_ID/enabled"] = { ...defineFile(async ({extensionId}) => {
  const info = await browser.management.get(extensionId);
  return String(info.enabled) + '\n';

}, async ({extensionId}, buf) => {
  await browser.management.setEnabled(extensionId, buf.trim() === "true");

  // suppress truncate so it doesn't accidentally flip the state when you do, e.g., `echo true >`
}), truncate() { return {}; } };

router["/runtime/reload"] = {
  async write({buf}) {
    await browser.runtime.reload();
    return {size: stringToUtf8Array(buf).length};
  },
  truncate() { return {}; }
};
router["/runtime/background.js.html"] = defineFile(async () => {
  const js = await window.fetch(chrome.runtime.getURL('background.js'))
                         .then(r => r.text());
  return `
<html>
  <body>
    <dl>
      ${Object.entries(router).map(([a, b]) => `
        <dt>${a}</dt>
        <dd>${b}</dd>
      `).join('\n')}
    </dl>
    <pre><code>${js}</code></pre>
  </body>
</html>
  `;
});

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


for (let key in router) {
  // /tabs/by-id/#TAB_ID/url.txt -> RegExp \/tabs\/by-id\/(?<int$TAB_ID>[0-9]+)\/url.txt
  router[key].__regex = new RegExp(
    '^' + key
      .split('/')
      .map(keySegment => keySegment
           .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
           .replace(/([#:])([A-Z_]+)/g, (_, sigil, varName) => {
             return `(?<${sigil === '#' ? 'int$' : 'string$'}${varName}>` +
                         (sigil === '#' ? '[0-9]+' : '[^/]+') + `)`;
           }))
      .join('/') + '$');

  router[key].__match = function(path) {
    const result = router[key].__regex.exec(path);
    if (!result) { return; }

    const vars = {};
    for (let [typeAndVarName, value] of Object.entries(result.groups || {})) {
      let [type_, varName] = typeAndVarName.split('$');
      // TAB_ID -> tabId
      varName = varName.toLowerCase();
      varName = varName.replace(/_([a-z])/g, c => c[1].toUpperCase());
      vars[varName] = type_ === 'int' ? parseInt(value) : value;
    }
    return vars;
  };

  // Fill in default implementations of fs ops:

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
      async getattr(req) {
        const st_size = (await this.readlink(req)).buf.length + 1;
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
      open() { return { fh: 0 }; },
      release() { return {}; },
      ...router[key]
    };
  }
}

function tryMatchRoute(path) {
  if (path.match(/\/\._[^\/]+$/)) {
    // Apple Double ._whatever file for xattrs
    throw new UnixError(unix.ENOTSUP); 
  }

  for (let route of Object.values(router)) {
    const vars = route.__match(path);
    if (vars) { return [route, vars]; }
  }
  throw new UnixError(unix.ENOENT);
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
    port.postMessage({ id: req.id, op: req.op, error: unix.ETIMEDOUT });
  }, 1000);

  /* console.time(req.op + ':' + req.path);*/
  try {
    const [route, vars] = tryMatchRoute(req.path);
    response = await route[req.op]({...req, ...vars});
    response.op = req.op;
    if (response.buf) { response.buf = btoa(response.buf); }

  } catch (e) {
    console.error(e);
    response = {
      op: req.op,
      error: e instanceof UnixError ? e.error : unix.EIO
    };
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
  port.onDisconnect.addListener(p => { console.log('disconnect', p); });
}


if (typeof process === 'object') {
  // we're running in node (as part of a test)
  // return everything they might want to test
  module.exports = {router, tryMatchRoute}; 

} else {
  tryConnect();
}
