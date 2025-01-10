declare global {
	interface Window {
		Routes: { [path: string]: RouteHandler };
		__backgroundJS?: string;
		browser: typeof chrome.browser;
	}
}

export interface DirectoryRouteHandler {
	readdir: (req: RequestObject) => Promise<{ entries: string[] }>;
	getattr: (req: RequestObject) => Promise<{ st_mode: number, st_nlink: number, st_size: number }>;
	opendir: (req: RequestObject) => Promise<{ fh: number }>;
	releasedir: (req: RequestObject) => Promise<{}> | {};
}

export interface WritableDirectoryRouteHandler extends RouteHandler {
	mknod: (req: RequestObject) => Promise<{}> | {};
	unlink: (req: RequestObject) => Promise<{}> | {};
}

export interface WritableDirectory {
	directory: { [key: string]: string };
	routeForRoot: RouteHandler;
	routeForFilename: WritableDirectoryRouteHandler;
}

export interface CacheInterface {
	store: { [handle: number]: { path: string, object: Uint8Array } };
	nextHandle: number;
	storeObject: (path: string, object: Uint8Array) => number;
	getObjectForHandle: (handle: number) => Uint8Array;
	setObjectForHandle: (handle: number, object: Uint8Array) => void;
	removeObjectForHandle: (handle: number) => void;
	setObjectForPath: (path: string, object: Uint8Array) => void;
}

export interface RouteHandler {
	description?: string;
	usage?: string | string[];
	getattr?: (req: RequestObject) => Promise<StatObject> | StatObject;
	readdir?: (req: RequestObject) => Promise<{ entries: string[] }> | { entries: string[] };
	read?: (req: RequestObject) => Promise<{ buf: string }> | { buf: string };
	write?: (req: RequestObject) => Promise<{ size: number }> | { size: number };
	truncate?: (req: RequestObject) => Promise<{}> | {};
	readlink?: (req: RequestObject) => Promise<{ buf: string }> | { buf: string };
	unlink?: (req: RequestObject) => Promise<{}> | {};
	mknod?: (req: RequestObject) => Promise<{}> | {};
	open?: (req: RequestObject) => Promise<{ fh?: number }> | { fh?: number };
	release?: (req: RequestObject) => Promise<{}> | {};
	opendir?: (req: RequestObject) => Promise<{ fh?: number }> | { fh?: number };
	releasedir?: (req: RequestObject) => Promise<{}> | {};
	__matchVarCount?: number;
	__regex?: RegExp;
	__match?: (path: string) => Record<string, any> | undefined;
	__isInfill?: boolean;
}

export interface RequestObject {
	path: string;
	buf?: string;
	size?: number;
	fh?: number;
	offset?: number;
	tabId?: number;
	windowId?: number;
	mode?: number;
	expr?: string;
	inputId?: string;
	extensionId?: string;
	filename?: string;
	suffix?: string;
}

export interface StatObject {
	st_mode: number;
	st_nlink: number;
	st_size: number;
}

export interface UnixConstants {
	EPERM: number;
	ENOENT: number;
	ESRCH: number;
	EINTR: number;
	EIO: number;
	ENXIO: number;
	ENOTSUP: number;
	ETIMEDOUT: number;
	S_IFMT: number;
	S_IFIFO: number;
	S_IFCHR: number;
	S_IFDIR: number;
	S_IFBLK: number;
	S_IFREG: number;
	S_IFLNK: number;
	S_IFSOCK: number;
}

export interface DebuggerScriptParsedEvent {
	scriptId: string;
	url: string;
	startLine?: number;
	endLine?: number;
}

export interface TabInfo {
	id?: number;
	url?: string;
	title?: string;
	active?: boolean;
	windowId?: number;
}

export interface WindowInfo {
	id: number;
	focused: boolean;
} 