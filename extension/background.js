/**
 * @typedef {object} UnixConstants
 * @property {number} EPERM - Operation not permitted
 * @property {number} ENOENT - No such file or directory
 * @property {number} ESRCH - No such process
 * @property {number} EINTR - Interrupted system call
 * @property {number} EIO - I/O error
 * @property {number} ENXIO - No such device or address
 * @property {number} ENOTSUP - Operation not supported
 * @property {number} ETIMEDOUT - Operation timed out
 * @property {number} S_IFMT - Type of file mask
 * @property {number} S_IFIFO - Named pipe
 * @property {number} S_IFCHR - Character special
 * @property {number} S_IFDIR - Directory
 * @property {number} S_IFBLK - Block special
 * @property {number} S_IFREG - Regular file
 * @property {number} S_IFLNK - Symbolic link
 * @property {number} S_IFSOCK - Socket
 */

/** @type {UnixConstants} */
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
  S_IFMT: 0o170000, // type of file mask
  S_IFIFO: 0o10000, // named pipe (fifo)
  S_IFCHR: 0o20000, // character special
  S_IFDIR: 0o40000, // directory
  S_IFBLK: 0o60000, // block special
  S_IFREG: 0o100000, // regular
  S_IFLNK: 0o120000, // symbolic link
  S_IFSOCK: 0o140000, // socket
}

/**
 * Custom error class for Unix-style errors
 * @augments Error
 */
class UnixError extends Error {
  /**
   * @param {number} error - Unix error code
   */
  constructor(error) {
    super();
    this.name = "UnixError";
    this.error = error;
  }
}

/**
 * Sanitizes a filename by replacing illegal characters
 * @param {string} input - The filename to sanitize
 * @returns {string} The sanitized filename
 */
const sanitize = (function () {
  // from https://github.com/parshap/node-sanitize-filename/blob/209c39b914c8eb48ee27bcbde64b2c7822fdf3de/index.js

  // I've added ' ' to the list of illegal characters. it's a
  // decision whether we want to allow spaces in filenames... I think
  // they're annoying, so I'm sanitizing them out for now.
  var illegalRe = /[\/\?<>\\:\*\|" ]/g;
  var controlRe = /[\x00-\x1f\x80-\x9f]/g;
  var reservedRe = /^\.+$/;
  var windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  var windowsTrailingRe = /[\. ]+$/;

  /**
   * @param {string} input - Input string to sanitize
   * @param {string} replacement - Character to replace invalid characters with
   * @returns {string} Sanitized string with invalid characters replaced
   */
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

const stringToUtf8Array = (function () {
  const encoder = new TextEncoder();
  return str => encoder.encode(str);
})();

const utf8ArrayToString = (function () {
  const decoder = new TextDecoder("utf-8");
  return utf8 => decoder.decode(utf8);
})();

// btoa cannot be used on Uint8Arrays or strings containing utf8 characters.
// This is the best solution per https://stackoverflow.com/a/66046176
const utf8ArrayToBase64 = async (data) => {
  if (data.length == 0) return '';

  // Use a FileReader to generate a base64 data URI
  const base64url = await new Promise((r) => {
    const reader = new FileReader()
    reader.onload = () => r(reader.result)
    reader.readAsDataURL(new Blob([data]))
  });

  /*
  The result looks like
  "data:application/octet-stream;base64,<your base64 data>", 
  so we split off the beginning:
  */
  return base64url.split(",", 2)[1]
};

/**
 * Creates a writable directory object.
 * @returns {import('./types').WritableDirectory} A writable directory object.
 */
function createWritableDirectory() {
  /** @type {{[key: string]: string}} */
  const dir = {};
  /** @type {import('./types').DirectoryRouteHandler} */
  const routeForRoot = {
    async readdir({ path: _ }) {
      return {
        entries: [".", "..",
          ...Object.keys(dir).map(
            key => key.substr(key.lastIndexOf("/") + 1)
          )]
      };
    },
    async getattr() {
      return {
        st_mode: unix.S_IFDIR | 0o777,
        st_nlink: 3,
        st_size: 0,
      };
    },
    async opendir() { return { fh: 0 }; },
    releasedir() { return {}; }
  };
  return {
    directory: dir,
    routeForRoot,
    routeForFilename: ({
      mknod({ path, mode: __ }) {
        dir[path] = '';
        return {};
      },
      unlink({ path }) {
        delete dir[path];
        return {};
      },
      ...makeRouteWithContents(
        async ({ path }) => dir[path],
        async ({ path }, buf) => { dir[path] = buf; }
      )
    })
  };
}

/**
 * Creates a route handler for a file with specified contents
 * @param {Function} getData - Function to get file contents
 * @param {Function} [setData] - Optional function to set file contents
 * @returns {import('./types').RouteHandler} Route handler object
 */
const makeRouteWithContents = (function () {
  /** @type {import('./types').CacheInterface} */
  const Cache = {
    store: {}, nextHandle: 0,
    storeObject(path, object) {
      const handle = ++this.nextHandle;
      this.store[handle] = { path, object };
      return handle;
    },
    getObjectForHandle(handle) { return this.store[handle].object; },
    setObjectForHandle(handle, object) { this.store[handle].object = object; },
    removeObjectForHandle(handle) { delete this.store[handle]; },
    setObjectForPath(path, object) {
      for (let storedObject of Object.values(this.store)) {
        if (storedObject.path === path) {
          storedObject.object = object;
        }
      }
    }
  };

  /**
   * @param {string|Uint8Array} stringOrArray - Input string or array
   * @returns {Uint8Array} UTF8 array
   */
  function toUtf8Array(stringOrArray) {
    if (typeof stringOrArray == 'string') { return stringToUtf8Array(stringOrArray); }
    else { return stringOrArray; }
  }

  const makeRouteWithContents = (getData, setData) => ({
    // getData: (req: Request U Vars) -> Promise<contentsOfFile: String|Uint8Array>
    // setData [optional]: (req: Request U Vars, newContentsOfFile: String) -> Promise<>

    // You can override file operations (like `truncate` or `getattr`)
    // in the returned set if you want different behavior from what's
    // defined here.

    async getattr(req) {
      const data = await getData(req);
      if (typeof data === 'undefined') { throw new UnixError(unix.ENOENT); }
      return {
        st_mode: unix.S_IFREG | 0o444 | (setData ? 0o222 : 0),
        st_nlink: 1,
        // you'll want to override this if getData() is slow, because
        // getattr() gets called a lot more cavalierly than open().
        st_size: toUtf8Array(data).length
      };
    },

    // We call getData() once when the file is opened, then cache that
    // data for all subsequent reads from that application.
    async open(req) {
      const data = await getData(req);
      if (typeof data === 'undefined') { throw new UnixError(unix.ENOENT); }
      return { fh: Cache.storeObject(req.path, toUtf8Array(data)) };
    },
    async read(req) {
      const { fh, size, offset } = req;
      const buf = Cache.getObjectForHandle(fh).slice(offset, offset + size);
      return { buf: typeof buf === 'string' ? buf : utf8ArrayToString(buf) };
    },
    async write(req) {
      const { fh, offset, buf } = req;
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
    async release(req) {
      if (req.fh) {
        Cache.removeObjectForHandle(req.fh);
      }
      return {};
    },

    async truncate(req) {
      let arr = toUtf8Array(await getData(req));
      if (req.size !== arr.length) {
        const newArr = new Uint8Array(req.size);
        newArr.set(arr.slice(0, Math.min(req.size, arr.length)));
        arr = newArr;
      }
      Cache.setObjectForPath(req.path, arr);
      await setData(req, utf8ArrayToString(arr)); return {};
    }
  });
  makeRouteWithContents.Cache = Cache;
  return makeRouteWithContents;
})();

/**
 * @param {string} path - Directory path
 * @returns {import('./types').RouteHandler} Route handler object
 */
function makeDefaultRouteForDirectory(path) {
  /**
   * 
   * @param {string} p
   * @returns {number}
   */
  function depth(p) { return p === '/' ? 0 : (p.match(/\//g) || []).length; }

  return {
    async readdir() {
      let entries = Object.keys(Routes)
        .filter(k => k.startsWith(path) && depth(k) === depth(path) + 1)
        .map(k => k.substr((path === '/' ? 0 : path.length) + 1).split('/')[0])
        .filter(k => !k.includes("#") && !k.includes(":"));

      entries = [".", "..", ...new Set(entries)];
      return { entries };
    },
    async getattr() {
      return {
        st_mode: unix.S_IFDIR | 0o755,
        st_nlink: 3,
        st_size: 0,
      };
    },
    async opendir() { return { fh: 0 }; },
    async releasedir() { return {}; },
    __isInfill: true
  };
}

/**
 * Routes is a global object that contains all the routes for the extension.
 * @type {object}
 */
/** @type {{[path: string]: import('./types').RouteHandler}} */
var Routes = {};

window.Routes = Routes;

Routes["/tabs/create"] = {
  description: 'Create a new tab.',
  usage: 'echo "https://www.google.com" > $0',
  async write({ buf }) {
    const url = buf.trim();
    await chrome.tabs.create({ url });
    return { size: stringToUtf8Array(buf).length };
  },
  async truncate() { return {}; }
};

Routes["/tabs/by-title"] = {
  description: 'Open tabs, organized by title; each subfolder represents an open tab.',
  usage: 'ls $0',
  getattr() {
    return {
      st_mode: unix.S_IFDIR | 0o777, // writable so you can delete tabs
      st_nlink: 3,
      st_size: 0,
    };
  },
  async readdir() {
    const tabs = await chrome.tabs.query({});
    return { entries: [".", "..", ...tabs.map(tab => sanitize(String(tab.title)) + "." + String(tab.id))] };
  }
};

Routes["/tabs/by-title/:TAB_TITLE.#TAB_ID"] = {
  description: `Represents one open tab.
It's a symbolic link to the folder /tabs/by-id/#TAB_ID.`,
  // TODO: date
  usage: ['rm $0'],
  async readlink({ tabId }) {
    return { buf: "../by-id/" + tabId };
  },
  async unlink({ tabId }) {
    await chrome.tabs.remove(tabId);
    return {};
  }
};

Routes["/tabs/by-window"] = {
  description: 'Open tabs, organized by window then title; each subfolder represents an open tab.',
  usage: 'ls $0',
  getattr() {
    return {
      st_mode: unix.S_IFDIR | 0o777, // writable so you can delete tabs
      st_nlink: 3,
      st_size: 0,
    };
  },
  async readdir() {
    const tabs = await chrome.tabs.query({});
    return { entries: [".", "..", ...tabs.map(tab => sanitize(String(tab.windowId) + "." + String(tab.title)) + "." + String(tab.id))] };
  }
};

Routes["/tabs/by-window/#TAB_WINDOW_ID.:TAB_TITLE.#TAB_ID"] = {
  description: `Represents one open tab.
It's a symbolic link to the folder /tabs/by-id/#TAB_ID.`,
  // TODO: date
  usage: ['rm $0'],
  async readlink({ tabId }) {
    return { buf: "../by-id/" + tabId };
  },
  async unlink({ tabId }) {
    await chrome.tabs.remove(tabId);
    return {};
  }
};


Routes["/tabs/last-focused"] = {
  description: `Represents the most recently focused tab.
It's a symbolic link to the folder /tabs/by-id/[ID of most recently focused tab].`,
  async readlink() {
    const id = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id;
    return { buf: "by-id/" + id };
  }
};

Routes["/tabs/by-id"] = {
  description: `Open tabs, organized by ID; each subfolder represents an open tab.`,
  usage: 'ls $0',
  async readdir() {
    const tabs = await chrome.tabs.query({});
    return { entries: [".", "..", ...tabs.map(tab => String(tab.id))] };
  }
};

// TODO: temporarily disabled: make tab directory writable

// const tabIdDirectory = createWritableDirectory();
// Routes["/tabs/by-id/#TAB_ID"] = routeDefer(() => {
//   const childrenRoute = makeDefaultRouteForDirectory("/tabs/by-id/#TAB_ID");
//   return {
//     ...tabIdDirectory.routeForRoot, // so getattr is inherited
//     async readdir(req) {
//       const entries =
//             [...(await tabIdDirectory.routeForRoot.readdir(req)).entries,
//              ...(await childrenRoute.readdir(req)).entries];
//       return {entries: [...new Set(entries)]};
//     }
//   };
// });
// Routes["/tabs/by-id/#TAB_ID/:FILENAME"] = tabIdDirectory.routeForFilename;

// TODO: can I trigger 1. nav to Finder and 2. nav to Terminal from toolbar click?

(function () {
  /**
   * @typedef {object} TabInfo
   * @property {number} [id] - Tab ID (optional to match Chrome's type)
   * @property {string} [url] - Tab URL (optional to match Chrome's type)
   * @property {string} [title] - Tab title (optional to match Chrome's type)
   * @property {boolean} [active] - Whether tab is active (optional to match Chrome's type)
   * @property {number} [windowId] - Window ID (optional to match Chrome's type)
   * @param {(tab: TabInfo) => string} readHandler - Function to read tab data
   * @param {(buf: string) => object} [writeHandler] - Optional function to write tab data
   * @returns {import('./types').RouteHandler} Route handler
   */
  const routeForTab = (readHandler, writeHandler) => makeRouteWithContents(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.id) {
      throw new UnixError(unix.ENOENT);
    }
    // Type assertion to ensure tab has required properties
    /** @type {TabInfo} */
    const tabInfo = {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active || false,
      windowId: tab.windowId
    };
    return readHandler(tabInfo);
  }, writeHandler ? async ({ tabId }, buf) => {
    await chrome.tabs.update(tabId, writeHandler(buf));
  } : undefined);

  /**
   * Creates a route for a tab with read/write handlers.
   * @param {string} code - JavaScript code to execute in the tab
   * @returns {import('./types').RouteHandler} Route handler
   */
  const routeFromScript = code => makeRouteWithContents(async ({ tabId }) => {
    return (await chrome.tabs.executeScript(tabId, { code }))[0];
  });

  Routes["/tabs/by-id/#TAB_ID/url.txt"] = {
    description: `Text file containing the current URL of this tab.`,
    usage: ['cat $0',
      'echo "https://www.google.com" > $0'],
    ...routeForTab(tab => tab.url + "\n",
      buf => ({ url: buf }))
  };
  Routes["/tabs/by-id/#TAB_ID/title.txt"] = {
    description: `Text file containing the current title of this tab.`,
    usage: 'cat $0',
    ...routeForTab(tab => tab.title + "\n")
  };
  Routes["/tabs/by-id/#TAB_ID/text.txt"] = {
    description: `Text file containing the current body text of this tab.`,
    usage: 'cat $0',
    ...routeFromScript(`document.body.innerText`)
  };
  Routes["/tabs/by-id/#TAB_ID/body.html"] = {
    description: `Text file containing the current body HTML of this tab.`,
    usage: 'cat $0',
    ...routeFromScript(`document.body.innerHTML`)
  };

  Routes["/tabs/by-id/#TAB_ID/active"] = {
    description: 'Text file containing `true` or `false` depending on whether this tab is active in its window.',
    usage: ['cat $0',
      'echo true > $0'],
    ...routeForTab(
      tab => JSON.stringify(tab.active) + '\n',
      // WEIRD: we do startsWith because you might end up with buf
      // being "truee" (if it was "false", then someone wrote "true")
      buf => ({ active: buf.startsWith("true") })
    )
  };
})();

(function () {
  const evals = createWritableDirectory();
  Routes["/tabs/by-id/#TAB_ID/evals"] = {
    ...evals.routeForRoot,
    description: `Add JavaScript files to this folder to evaluate them in the tab.`,
    usage: 'ls $0',
    async opendir() { return { fh: 0 }; }
  };
  Routes["/tabs/by-id/#TAB_ID/evals/:FILENAME"] = {
    ...evals.routeForFilename,
    // FIXME: use $0 here
    // FIXME: document allFrames option
    usage: ['echo "2 + 2" > tabs/by-id/#TAB_ID/evals/twoplustwo.js',
      'cat tabs/by-id/#TAB_ID/evals/twoplustwo.js.result'],
    async write(req) {
      const ret = await evals.routeForFilename.write(req);
      const code = evals.directory[req.path];
      const allFrames = req.path.endsWith('.all-frames.js');
      // TODO: return other results beyond [0] (when all-frames is on)
      const result = (await chrome.tabs.executeScript(req.tabId, { code, allFrames }))[0];
      evals.directory[req.path + '.result'] = JSON.stringify(result) + '\n';
      return ret;
    }
  };
})();
(function () {
  const watches = {};
  Routes["/tabs/by-id/#TAB_ID/watches"] = {
    description: `Put a file in this folder with a JS expression as its filename.
Read that file to evaluate and return the current value of that JS expression.`,
    usage: 'ls $0',
    async readdir({ tabId }) {
      return { entries: [".", "..", ...Object.keys(watches[tabId] || [])] };
    },
    getattr() {
      return {
        st_mode: unix.S_IFDIR | 0o777, // writable so you can create/rm watches
        st_nlink: 3,
        st_size: 0,
      };
    },
  };
  Routes["/tabs/by-id/#TAB_ID/watches/:EXPR"] = /** @type {import('./types').RouteHandler} */ ({
    description: `A file with a JS expression :EXPR as its filename.`,
    usage: `touch '/tabs/by-id/#TAB_ID/watches/2+2' && cat '/tabs/by-id/#TAB_ID/watches/2+2'`,
    // NOTE: eval runs in extension's content script, not in original page JS context
    async mknod({ tabId, expr, mode: _ }) {
      watches[tabId] = watches[tabId] || {};
      watches[tabId][expr] = async function () {
        return (await chrome.tabs.executeScript(tabId, { code: expr }))[0];
      };
      return {};
    },
    async unlink({ tabId, expr }) {
      delete watches[tabId][expr]; // TODO: also delete watches[tabId] if empty
      return {};
    },

    ...makeRouteWithContents(async ({ tabId, expr }) => {
      if (!watches[tabId] || !(expr in watches[tabId])) { throw new UnixError(unix.ENOENT); }
      return JSON.stringify(await watches[tabId][expr]()) + '\n';
    }, () => {
      // setData handler -- only providing this so that getattr reports
      // that the file is writable, so it can be deleted without annoying prompt.
      throw new UnixError(unix.EPERM);
    })
  });
})();
Routes["/windows/#WINDOW_ID/create"] = {
  async write({ windowId, buf }) {
    const url = buf.trim();
    await chrome.tabs.create({ windowId: windowId, url: url });
    return { size: stringToUtf8Array(buf).length };
  },
  async truncate() { return {}; }
}
Routes["/tabs/by-id/#TAB_ID/window"] = {
  description: `The window that this tab lives in;
a symbolic link to the folder /windows/[id for this window].`,
  async readlink({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    return { buf: "../../../windows/" + tab.windowId };
  }
};
Routes["/tabs/by-id/#TAB_ID/control"] = {
  description: `Write control commands to this file to control this tab;
see https://developer.chrome.com/extensions/tabs.`,
  usage: ['echo remove > $0',
    'echo reload > $0',
    'echo goForward > $0',
    'echo goBack > $0',
    'echo discard > $0'],
  async write({ tabId, buf }) {
    const command = buf.trim();
    await chrome.tabs[command](tabId);
    return { size: stringToUtf8Array(buf).length };
  },
  async truncate({ size: _ }) { return {}; }
};
// debugger/ : debugger-API-dependent (Chrome-only)
(function () {
  if (!chrome.debugger) return;

  /**
   * @typedef {object} DebuggerScriptParsedEvent
   * @property {string} scriptId
   * @property {string} url
   * @property {number} [startLine]
   * @property {number} [endLine]
   */

  if (chrome.debugger) chrome.debugger.onEvent.addListener((source, method, /** @type {any} */ params) => {
    console.log(source, method, params);
    if (method === "Page.frameStartedLoading") {
      TabManager.scriptsForTab[source.tabId] = {};
    } else if (method === "Debugger.scriptParsed") {
      /** @type {DebuggerScriptParsedEvent} */
      const scriptParams = params;
      TabManager.scriptsForTab[source.tabId] = TabManager.scriptsForTab[source.tabId] || {};
      TabManager.scriptsForTab[source.tabId][scriptParams.scriptId] = scriptParams;
    }
  });

  /**
   * @param {number} tabId - Tab ID to attach debugger to
   * @returns {Promise<void>} Promise that resolves when debugger is attached
   */
  async function attachDebugger(tabId) {
    return new Promise((resolve, reject) => chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); }
      else { resolve(); }
    }));
  }
  /**
   * @param {number} tabId - Tab ID to detach debugger from
   * @returns {Promise<void>} Promise that resolves when debugger is detached
   */
  async function detachDebugger(tabId) {
    return new Promise((resolve, reject) => chrome.debugger.detach({ tabId }, () => {
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); }
      else { resolve(); }
    }));
  }
  const TabManager = (function () {
    /** @type {{[tabId: number]: {[scriptId: string]: DebuggerScriptParsedEvent}}} */
    const scriptsForTab = {};

    if (chrome.debugger) chrome.debugger.onEvent.addListener((source, method, /** @type {any} */ params) => {
      console.log(source, method, params);
      if (method === "Page.frameStartedLoading") {
        TabManager.scriptsForTab[source.tabId] = {};
      } else if (method === "Debugger.scriptParsed") {
        /** @type {DebuggerScriptParsedEvent} */
        const scriptParams = params;
        TabManager.scriptsForTab[source.tabId] = TabManager.scriptsForTab[source.tabId] || {};
        TabManager.scriptsForTab[source.tabId][scriptParams.scriptId] = scriptParams;
      }
    });

    return {
      scriptsForTab,
      debugTab: async function (tabId) {
        try { await attachDebugger(tabId); }
        catch (e) {
          if (e.message.indexOf('Another debugger is already attached') !== -1) {
            await detachDebugger(tabId);
            await attachDebugger(tabId);
          }
        }
      },
      enableDomainForTab: async function (tabId, domain) {
        if (domain === 'Debugger') { TabManager.scriptsForTab[tabId] = {}; }
        await sendDebuggerCommand(tabId, `${domain}.enable`, {});
      }
    };
  })();
  /**
   * @param {number} tabId - Tab ID to send command to
   * @param {string} method - Debugger method to call
   * @param {object} commandParams - Parameters for debugger command
   * @returns {Promise<any>} Promise that resolves with command result
   */
  function sendDebuggerCommand(tabId, method, commandParams) {
    return new Promise((resolve, reject) =>
      chrome.debugger.sendCommand({ tabId }, method, commandParams, result => {
        if (result) { resolve(result); } else { reject(chrome.runtime.lastError); }
      })
    );
  }

  // possible idea: console (using Log API instead of monkey-patching)
  // resources/
  // TODO: scripts/ TODO: allow creation, eval immediately

  Routes["/tabs/by-id/#TAB_ID/debugger/resources"] = {
    async readdir({ tabId }) {
      await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");
      const { frameTree } = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
      return { entries: [".", "..", ...frameTree.resources.map(r => sanitize(String(r.url)))] };
    }
  };
  Routes["/tabs/by-id/#TAB_ID/debugger/resources/:SUFFIX"] = makeRouteWithContents(async ({ path: _, tabId, suffix }) => {
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");

    const { frameTree } = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    for (let resource of frameTree.resources) {
      const resourceSuffix = sanitize(String(resource.url));
      if (resourceSuffix === suffix) {
        let { base64Encoded, content } = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
          frameId: frameTree.frame.id,
          url: resource.url
        });
        if (base64Encoded) { return Uint8Array.from(atob(content), c => c.charCodeAt(0)); }
        return content;
      }
    }
    throw new UnixError(unix.ENOENT);
  });
  Routes["/tabs/by-id/#TAB_ID/debugger/scripts"] = {
    async opendir({ tabId }) {
      await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Debugger");
      return { fh: 0 };
    },
    async readdir({ tabId }) {
      // it's useful to put the ID first in the script filenames, so
      // the .js extension stays on the end
      const scriptFileNames = Object.values(TabManager.scriptsForTab[tabId])
        .map(params => params.scriptId + "_" + sanitize(params.url));
      return { entries: [".", "..", ...scriptFileNames] };
    }
  };
  /**
   * @param {number} tabId - Tab ID to get script info for
   * @param {string} filename - Script filename
   * @typedef {object} DebuggerScriptInfo
   * @property {string} scriptId - Script ID
   * @property {string} url - Script URL
   * @returns {DebuggerScriptInfo} Script info object
   * @throws {UnixError} If script not found
   */
  function pathScriptInfo(tabId, filename) {
    const [scriptId, ...rest] = filename.split("_");
    const scriptInfo = TabManager.scriptsForTab[tabId][scriptId];
    if (!scriptInfo || sanitize(scriptInfo.url) !== rest.join("_")) {
      throw new UnixError(unix.ENOENT);
    }
    return scriptInfo;
  }
  Routes["/tabs/by-id/#TAB_ID/debugger/scripts/:FILENAME"] = /** @type {import('./types').RouteHandler} */ ({
    description: `A file representing a script in the debugger.`,
    ...makeRouteWithContents(async ({ tabId, filename }) => {
      await TabManager.debugTab(tabId);
      await TabManager.enableDomainForTab(tabId, "Page");
      await TabManager.enableDomainForTab(tabId, "Debugger");

      const { scriptId } = pathScriptInfo(tabId, filename);
      const { scriptSource } = await sendDebuggerCommand(tabId, "Debugger.getScriptSource", { scriptId });
      return scriptSource;

    }, async ({ tabId, filename }, buf) => {
      await TabManager.debugTab(tabId);
      await TabManager.enableDomainForTab(tabId, "Debugger");

      const { scriptId } = pathScriptInfo(tabId, filename);
      await sendDebuggerCommand(tabId, "Debugger.setScriptSource", { scriptId, scriptSource: buf });
    }),
    async release(req) {
      return {};
    }
  });
})();

Routes["/tabs/by-id/#TAB_ID/inputs"] = {
  description: `Contains a file for each text input and textarea on this page (as long as it has an ID, currently).`,
  async readdir({ tabId }) {
    // TODO: assign new IDs to inputs without them?
    const code = `Array.from(document.querySelectorAll('textarea, input[type=text]'))
                    .map(e => e.id).filter(id => id)`;
    const ids = (await chrome.tabs.executeScript(tabId, { code }))[0];
    return { entries: [".", "..", ...ids.map(id => `${id}.txt`)] };
  }
};
Routes["/tabs/by-id/#TAB_ID/inputs/:INPUT_ID.txt"] = {
  ...makeRouteWithContents(async ({ tabId, inputId }) => {
    const code = `document.getElementById('${inputId}').value`;
    const inputValue = (await chrome.tabs.executeScript(tabId, { code }))[0];
    if (inputValue === null) {
      throw new UnixError(unix.ENOENT);
    }
    return inputValue;
  }, async ({ tabId, inputId }, buf) => {
    const code = `document.getElementById('${inputId}').value = unescape('${escape(buf)}')`;
    await chrome.tabs.executeScript(tabId, { code });
  }),
  // Override release to match RequestObject type
  async release(req) {
    return {};
  }
};

Routes["/windows"] = {
  async readdir() {
    const windows = await chrome.windows.getAll();
    return { entries: [".", "..", ...windows.map(window => String(window.id))] };
  }
};

Routes["/windows/#WINDOW_ID/tabs"] = {
  async readdir({ windowId }) {
    const tabs = await chrome.tabs.query({ windowId });
    return { entries: [".", "..", ...tabs.map(tab => sanitize(String(tab.title) + "." + String(tab.id)))] }
  }
}

Routes["/windows/#WINDOW_ID/tabs/:TAB_TITLE.#TAB_ID"] = {
  description: "A symbolic link to a tab in the window",
  async getattr(req) {
    const linkPath = "../../../tabs/by-id/" + req.tabId;
    return {
      st_mode: unix.S_IFLNK | 0o444,
      st_nlink: 1,
      st_size: linkPath.length + 1
    };
  },
  async readlink({ tabId }) {
    return { buf: "../../../tabs/by-id/" + tabId };
  },
  async unlink({ tabId }) {
    await chrome.tabs.remove(tabId);
    return {};
  }
};

Routes["/windows/last-focused"] = {
  description: `A symbolic link to /windows/[id for the last focused window].`,
  async readlink() {
    const windowId = (await chrome.windows.getLastFocused()).id;
    return { buf: String(windowId) };
  }
};

(function () {
  /**
   * @typedef {object} WindowInfo
   * @property {number} id - Window ID
   * @property {boolean} focused - Whether window is focused
   */

  /**
   * @param {(window: WindowInfo) => string} readHandler
   * @param {(buf: string) => object} [writeHandler]
   * @returns {import('./types').RouteHandler}
   */
  const withWindow = (readHandler, writeHandler) => makeRouteWithContents(async ({ windowId }) => {
    const window = await chrome.windows.get(windowId);
    if (!window || !window.id) {
      throw new UnixError(unix.ENOENT);
    }
    return readHandler({
      id: window.id,
      focused: window.focused || false
    });
  }, writeHandler ? async ({ windowId }, buf) => {
    await chrome.windows.update(windowId, writeHandler(buf));
  } : undefined);

  Routes["/windows/#WINDOW_ID/focused"] =
    withWindow(window => JSON.stringify(window.focused) + '\n',
      buf => ({ focused: buf.startsWith('true') }));
})();
Routes["/windows/#WINDOW_ID/visible-tab.png"] = {
  ...makeRouteWithContents(async ({ windowId }) => {
    // screen capture is a window thing and not a tab thing because you
    // can only capture the visible tab for each window anyway; you
    // can't take a screenshot of just any arbitrary tab
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return Uint8Array.from(atob(dataUrl.substr(("data:image/png;base64,").length)),
      c => c.charCodeAt(0));

  }), async getattr() {
    return {
      st_mode: unix.S_IFREG | 0o444,
      st_nlink: 1,
      st_size: 10000000 // hard-code to 10MB for now
    };
  }
};


Routes["/extensions"] = {
  async readdir() {
    const infos = await chrome.management.getAll();
    return { entries: [".", "..", ...infos.map(info => `${sanitize(info.name)}.${info.id}`)] };
  }
};
Routes["/extensions/:EXTENSION_TITLE.:EXTENSION_ID/enabled"] = {
  ...makeRouteWithContents(async ({ extensionId }) => {
    const info = await chrome.management.get(extensionId);
    return String(info.enabled) + '\n';

  }, async ({ extensionId }, buf) => {
    await chrome.management.setEnabled(extensionId, buf.trim() === "true");

    // suppress truncate so it doesn't accidentally flip the state when you do, e.g., `echo true >`
  }), truncate() { return {}; }
};

Routes["/runtime/reload"] = {
  async write({ buf }) {
    await chrome.runtime.reload();
    return { size: stringToUtf8Array(buf).length };
  },
  truncate() { return {}; }
};

window.fetch(chrome.runtime.getURL('background.js'))
  .then(async r => { window.__backgroundJS = await r.text(); });

Routes["/runtime/routes.html"] = makeRouteWithContents(async () => {
  if (!window.__backgroundJS) throw new UnixError(unix.EIO);

  // WIP
  const jsLines = (window.__backgroundJS).split('\n');
  /**
   * @param {string} path - Route path to find line range for
   * @returns {[number, number]|null} Start and end line numbers, or null if not found
   */
  function findRouteLineRange(path) {
    for (let i = 0; i < jsLines.length; i++) {
      if (jsLines[i].includes(`Routes["${path}"] = `)) {
        if (jsLines[i].match(/;/)) { return [i, i]; } // hacky: if it's a one-liner
        const result = jsLines[i].match(/Routes\[[^\]]*\] = [^\(\{]*([\(\{])/);
        const startBracket = result[1];
        const startBracketIndex = result.index + result[0].length;

        const endBracket = ({ '(': ')', '{': '}' })[startBracket];
        let counter = 1;
        for (let j = i; j < jsLines.length; j++) {
          for (let k = (j === i) ? startBracketIndex + 1 : 0;
            k < jsLines[j].length;
            k++) {
            if (jsLines[j][k] === startBracket) { counter++; }
            else if (jsLines[j][k] === endBracket) { counter--; }

            if (counter === 0) { return [i, j]; }
          }
        }
        return null; // did not find
      }
    }
    return null; // did not find
  }
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      dt:not(:first-of-type) { margin-top: 1em; }
      .description { font-style: italic; }
      summary { color: #555; }
    </style>
  </head>
  <body>
    <p>This page is automatically generated from <a href="https://github.com/osnr/TabFS/blob/master/extension/background.js">extension/background.js in the TabFS source code</a>.</p>
    <p>It documents each of the folders and files that TabFS serves up from your chrome.</p>
    <p>Variables in this document, like :TAB_TITLE and #TAB_ID, are stand-ins for concrete values of what you actually have open in your chrome in a running TabFS.</p>
    <p>(work in progress)</p>
    <dl>
      ` + Object.entries(Routes).map(([path, { usage, description, __isInfill, readdir }]) => {
    if (__isInfill) { return ''; }
    let usages = usage ? (Array.isArray(usage) ? usage : [usage]) : [];
    usages = usages.map(u => u.replace('\$0', path.substring(1) /* drop leading / */));
    const lineRange = findRouteLineRange(path);
    return `
          <dt>${readdir ? '&#x1F4C1;' : '&#x1F4C4;'} ${path.substring(1)}</dt>
          ${description ? `<dd class="description">${description}</dd>` :
        '<dd style="background-color: #f99">No description found!</dd>'}
          ${usages.length > 0 ? `<dd><details><summary>Usage examples</summary>
            <ul>
              ${usages.map(u => `<li>${u}</li>`).join('\n')}
            </ul>
          </details></dd>` : '<dd style="background-color: #f99">No usage examples found!</dd>'}
          ${lineRange ?
        `<dd><details>
              <summary>Source code (<a href="https://github.com/osnr/TabFS/blob/master/extension/background.js#L${lineRange[0] + 1}-L${lineRange[1] + 1}">on GitHub</a>)</summary>
              <pre><code>${jsLines.slice(lineRange[0], lineRange[1] + 1).join('\n')
        // FIXME: escape for HTML
        }</code></pre>
            </details></dd>` : '<dd style="background-color: #f99">No source code found!</dd>'}
        `;
  }).join('\n') + `
    </dl>
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
  for (let path of Object.keys(Routes).filter(key => key.split("/").length === i)) {
    path = path.substr(0, path.lastIndexOf("/"));
    if (path == '') path = '/';

    if (!Routes[path]) { Routes[path] = makeDefaultRouteForDirectory(path); }
  }
  // I also think it would be better to compute this stuff on the fly,
  // so you could patch more routes in at runtime, but I need to think
  // a bit about how to make that work with wildcards.
}


for (let key in Routes) {
  // /tabs/by-id/#TAB_ID/url.txt -> RegExp \/tabs\/by-id\/(?<int$TAB_ID>[0-9]+)\/url.txt
  Routes[key].__matchVarCount = 0;
  Routes[key].__regex = new RegExp(
    '^' + key
      .split('/')
      .map(keySegment => keySegment
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/([#:])([A-Z_]+)/g, (_, sigil, varName) => {
          Routes[key].__matchVarCount++;
          return `(?<${sigil === '#' ? 'int$' : 'string$'}${varName}>` +
            (sigil === '#' ? '[0-9]+' : '[^/]+') + `)`;
        }))
      .join('/') + '$');

  Routes[key].__match = function (path) {
    const result = Routes[key].__regex.exec(path);
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
  if (Routes[key].readdir) {
    Routes[key] = {
      async getattr() {
        return {
          st_mode: unix.S_IFDIR | 0o755,
          st_nlink: 3,
          st_size: 0,
        };
      },
      async opendir() { return { fh: 0 }; },
      async releasedir() { return {}; },
      async open() { return { fh: 0 }; },
      async read() { return { buf: "" }; },
      async release() { return {}; },
      ...Routes[key]
    };

  } else if (Routes[key].readlink) {
    Routes[key] = {
      async getattr(req) {
        const st_size = (await this.readlink(req)).buf.length + 1;
        return {
          st_mode: unix.S_IFLNK | 0o444,
          st_nlink: 1,
          st_size
        };
      },
      ...Routes[key]
    };

  } else if (Routes[key].read || Routes[key].write) {
    Routes[key] = {
      async getattr() {
        return {
          st_mode: unix.S_IFREG | ((Routes[key].read && 0o444) | (Routes[key].write && 0o222)),
          st_nlink: 1,
          st_size: 100 // FIXME
        };
      },
      async open() { return { fh: 0 }; },
      async release() { return {}; },
      ...Routes[key]
    };
  }
}

// most specific (lowest matchVarCount) routes should match first
const sortedRoutes = Object.values(Routes).sort((a, b) =>
  a.__matchVarCount - b.__matchVarCount
);
/**
 * @param {string} path - Path to match
 * @returns {[import('./types').RouteHandler, object]} Tuple of [route, variables]
 * @throws {UnixError} If no route matches
 */
function tryMatchRoute(path) {
  if (path.match(/\/\._[^\/]+$/)) {
    // Apple Double ._whatever file for xattrs
    throw new UnixError(unix.ENOTSUP);
  }

  for (let route of sortedRoutes) {
    const vars = route.__match(path);
    if (vars) {
      // Add default implementations based on route type
      if (route.readdir) {
        route.getattr = route.getattr || (async () => ({
          st_mode: unix.S_IFDIR | 0o755,
          st_nlink: 3,
          st_size: 0,
        }));
        route.opendir = route.opendir || (async () => ({ fh: 0 }));
        route.releasedir = route.releasedir || (async () => ({}));
      } else if (route.readlink) {
        route.getattr = route.getattr || (async (req) => {
          const st_size = (await route.readlink(req)).buf.length + 1;
          return {
            st_mode: unix.S_IFLNK | 0o444,
            st_nlink: 1,
            st_size
          };
        });
      } else if (route.read || route.write) {
        route.getattr = route.getattr || (async () => ({
          st_mode: unix.S_IFREG | ((route.read && 0o444) | (route.write && 0o222)),
          st_nlink: 1,
          st_size: 100 // FIXME
        }));
        route.open = route.open || (async () => ({ fh: 0 }));
        route.release = route.release || (async () => ({}));
      }
      return [route, vars];
    }
  }
  throw new UnixError(unix.ENOENT);
}

let port;
/**
 * @param {object} req - Request object from native host
 * @param {string} req.path - Path being accessed
 * @param {string} [req.buf] - Buffer contents
 * @param {string} req.op - Operation being performed
 * @param {number} req.id - Request ID
 * @returns {Promise<void>}
 */
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
    response = await route[req.op]({ ...req, ...vars });
    response.op = req.op;
    if (response.buf) {
      if (response.buf instanceof Uint8Array) {
        response.buf = await utf8ArrayToBase64(response.buf);
      } else {
        response.buf = btoa(response.buf);
      }
    }

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
}

/**
 * @returns {void}
 */
function tryConnect() {
  // Safari is very weird -- it has this native app that we have to talk to,
  // so we poke that app to wake it up, get it to start the TabFS process
  // and boot a WebSocket, then connect to it.
  // Is there a better way to do this?
  if (chrome.runtime.getURL('/').startsWith('safari-web-extension://')) { // Safari-only
    chrome.runtime.sendNativeMessage('com.rsnous.tabfs', { op: 'safari_did_connect' }, resp => {
      console.log(resp);

      let socket;
      /**
       * @param {number} checkAfterTime - Time to wait before checking connection
       * @returns {void}
       */
      function connectSocket(checkAfterTime) {
        socket = new WebSocket('ws://localhost:9991');
        socket.addEventListener('message', event => {
          onMessage(JSON.parse(event.data));
        });

        port = {
          postMessage(message) {
            socket.send(JSON.stringify(message));
          }
        };

        setTimeout(() => {
          if (socket.readyState === 1) {
            // ws connection was successful
          } else {
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
  port.onDisconnect.addListener(p => {
    console.log('disconnect', p);
  });
}


if (typeof process === 'object') {
  // we're running in node (as part of a test)
  // return everything they might want to test
  module.exports = { Routes, tryMatchRoute };

} else {
  tryConnect();
}

