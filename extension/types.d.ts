// add; window.Routes = Routes;




declare interface RouteHandler {
	description?: string;
	usage?: string | string[];
	getattr?: (req: RequestObject) => Promise<StatObject> | StatObject;
	readdir?: (req: RequestObject) => Promise<{ entries: string[] }> | { entries: string[] };
	read?: (req: RequestObject) => Promise<{ buf: string }> | { buf: string };
	write?: (req: RequestObject) => Promise<{ size: number }> | { size: number };
	truncate?: (req: RequestObject) => Promise<{}> | {};
	readlink?: (req: RequestObject) => Promise<{ buf: string }> | { buf: string };
	unlink?: (req: RequestObject) => Promise<{}> | {};
	open?: (req: RequestObject) => Promise<{ fh: number }> | { fh: number };
	release?: (req: RequestObject) => Promise<{}> | {};
	opendir?: (req: RequestObject) => Promise<{ fh: number }> | { fh: number };
	releasedir?: (req: RequestObject) => Promise<{}> | {};
	__matchVarCount?: number;
	__regex?: RegExp;
	__match?: (path: string) => Record<string, any> | undefined;
	__isInfill?: boolean;
}

declare interface RequestObject {
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
}

declare interface StatObject {
	st_mode: number;
	st_nlink: number;
	st_size: number;
}

declare interface UnixConstants {
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