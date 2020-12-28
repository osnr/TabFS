// This file should rarely need to be changed. (which is intentional,
// because it is a pain to program here, it's a pain to recompile and
// reload it, and it's a pain to debug it.)  Most of the real meat of
// TabFS is on the extension side, not here.

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <pthread.h>
#include <fuse.h>

#include "vendor/frozen.h"
#include "vendor/frozen.c"

FILE* l;

static void send_request(const char *fmt, ...) {
    va_list args; va_start(args, fmt);

    char request_data[1024*1024]; // max size of native->Chrome message
    struct json_out out = JSON_OUT_BUF(request_data, sizeof(request_data));
    unsigned int request_len = json_vprintf(&out, fmt, args);

    va_end(args);

    write(1, (char *) &request_len, 4); // stdout
    unsigned int bytes_written = 0;
    while (bytes_written < request_len) {
        bytes_written += write(1, request_data, request_len);
    }
    /* fprintf(l, "req[%s]\n", request_data); fflush(l); */
}

static int await_response(char **resp) {
    unsigned int response_len;
    read(0, (char *) &response_len, 4); // stdin
    char *response_data = malloc(response_len);
    unsigned int bytes_read = 0;
    while (bytes_read < response_len) {
        bytes_read += read(0, response_data + bytes_read, response_len);
    }
    /* fprintf(l, "resp(%d; expected %d)[%s]\n", bytes_read, response_len, response_data); fflush(l); */
    if (response_data == NULL) {
        // Connection is dead.
        *resp = "{ \"error\": 5 }";
        return strlen(*resp);
    }

    *resp = response_data;
    return response_len;
}

#define receive_response(fmt, ...)                                      \
    do {                                                                \
        char *resp; int resp_len;                                       \
        resp_len = await_response(&resp);                               \
        if (!resp_len) return -EIO;                                     \
                                                                        \
        int err;                                                        \
        if (json_scanf(resp, resp_len, "{error: %d}", &err) && err) {   \
            free(resp); return -err;                                    \
        }                                                               \
                                                                        \
        json_scanf(resp, resp_len, fmt, __VA_ARGS__);                   \
        free(resp);                                                     \
    } while (0)

static int tabfs_getattr(const char *path, struct stat *stbuf) {
    send_request("{op: %Q, path: %Q}", "getattr", path);

    memset(stbuf, 0, sizeof(struct stat));
    receive_response("{st_mode: %d, st_nlink: %d, st_size: %d}",
                     &stbuf->st_mode, &stbuf->st_nlink, &stbuf->st_size);
    return 0;
}

static int tabfs_readlink(const char *path, char *buf, size_t size) {
    send_request("{op: %Q, path: %Q}", "readlink", path);

    char *scan_buf; int scan_len;
    receive_response("{buf: %V}", &scan_buf, &scan_len);
    memcpy(buf, scan_buf, scan_len < size ? scan_len : size); free(scan_buf);

    return 0;
}

static int tabfs_open(const char *path, struct fuse_file_info *fi) {
    send_request("{op: %Q, path: %Q, flags: %d}", "open", path, fi->flags);

    receive_response("{fh: %d}", &fi->fh);

    return 0;
}

static int
tabfs_read(const char *path, char *buf, size_t size, off_t offset,
           struct fuse_file_info *fi) {
    send_request("{op: %Q, path: %Q, size: %d, offset: %d, fh: %d, flags: %d}",
                 "read", path, size, offset, fi->fh, fi->flags);

    char *scan_buf; int scan_len;
    receive_response("{buf: %V}", &scan_buf, &scan_len);
    memcpy(buf, scan_buf, scan_len < size ? scan_len : size); free(scan_buf);

    return scan_len;
}

static int
tabfs_write(const char *path, const char *buf, size_t size, off_t offset,
            struct fuse_file_info *fi) {
    
    send_request("{op: %Q, path: %Q, buf: %V, offset: %d, fh: %d, flags: %d}",
                 "write", path, buf, size, offset, fi->fh, fi->flags);

    int ret; receive_response("{size: %d}", &ret); return ret;
}

static int tabfs_release(const char *path, struct fuse_file_info *fi) {
    send_request("{op: %Q, path: %Q, fh: %d}",
                 "release", path, fi->fh);

    receive_response("{}", NULL);
    return 0;
}

static int tabfs_opendir(const char *path, struct fuse_file_info *fi) {
    send_request("{op: %Q, path: %Q, flags: %d}",
                 "opendir", path, fi->flags);
    
    receive_response("{fh: %d}", &fi->fh);
    return 0;
}

static int
tabfs_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
              off_t offset, struct fuse_file_info *fi) {
    send_request("{op: %Q, path: %Q, offset: %d}",
                 "readdir", path, offset);

    char *resp; int resp_len;
    resp_len = await_response(&resp);
    if (!resp_len) return -EIO;

    struct json_token t;
    for (int i = 0; json_scanf_array_elem(resp, resp_len, ".entries", i, &t) > 0; i++) {
        char entry[t.len + 1]; snprintf(entry, t.len + 1, "%.*s", t.len, t.ptr);
        filler(buf, entry, NULL, 0);
    }

    free(resp);
    return 0;
}

static int tabfs_releasedir(const char *path, struct fuse_file_info *fi) {
    send_request("{op: %Q, path: %Q, fh: %d}",
                 "releasedir", path, fi->fh);

    receive_response("{}", NULL);
    return 0;
}

static int tabfs_truncate(const char *path, off_t size) {
    send_request("{op: %Q, path: %Q, size: %d}",
                 "truncate", path, size);

    receive_response("{}", NULL);
    return 0;
}

static int tabfs_unlink(const char *path) {
    send_request("{op: %Q, path: %Q}", "unlink", path);

    receive_response("{}", NULL);
    return 0;
}

static struct fuse_operations tabfs_filesystem_operations = {
    .getattr  = tabfs_getattr, /* To provide size, permissions, etc. */
    .readlink = tabfs_readlink,

    .open     = tabfs_open,    /* To enforce read-only access.       */
    .read     = tabfs_read,    /* To provide file content.           */
    .write    = tabfs_write,
    .release  = tabfs_release,

    .opendir  = tabfs_opendir,
    .readdir  = tabfs_readdir, /* To provide directory listing.      */
    .releasedir = tabfs_releasedir,

    .truncate  = tabfs_truncate,
    .unlink = tabfs_unlink
};

int main(int argc, char **argv) {
    char killcmd[1000];
    sprintf(killcmd, "pgrep tabfs | grep -v %d | xargs kill -9", getpid());
    system(killcmd);
#ifdef __APPLE__
    system("diskutil umount force mnt > /dev/null");
#else
    system("fusermount -u mnt");
#endif

    l = fopen("log.txt", "w");
    for (int i = 0; i < argc; i++) {
        fprintf(l, "arg%d: [%s]\n", i, argv[i]); fflush(l);
    }
    char* fuse_argv[] = {argv[0], "-odirect_io", "-s", "-f", "mnt"};
    return fuse_main(5, fuse_argv, &tabfs_filesystem_operations, NULL);
}
