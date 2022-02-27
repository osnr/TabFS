// This file should rarely need to be changed. (which is intentional,
// because it is a pain to program here, it's a pain to recompile and
// reload it, and it's a pain to debug it.)  Most of the behavior of
// TabFS -- the definitions of the synthetic files -- lives on the
// extension side, not here.

#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
#include <pthread.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#include <assert.h>

#include <fuse.h>

#include "vendor/frozen.h"
#include "vendor/frozen.c"

static unsigned int get_thread_id(void) {
#if defined(__CYGWIN__)
    // note: using this because pthread_self() didn't seem to be unique under cygwin
    extern int GetCurrentThreadId(void);
    return GetCurrentThreadId();
#else
    return (uintptr_t)pthread_self();
#endif
}

#define eprintln(fmt, ...) fprintf(stderr, fmt "\n", ##__VA_ARGS__)

// protects:
// - writing to stdout
// - the "waiters" global
static pthread_mutex_t write_lock = PTHREAD_MUTEX_INITIALIZER;

struct resumedata {
    unsigned int id;
    int msgpipe[2];
    void *data;
    size_t size;
};

static struct resumedata **waiters;
static size_t numwaiters;

static void read_or_die(int fd, void *buf, size_t sz) {
    size_t sofar = 0;
    while (sofar < sz) {
        ssize_t rv = read(fd, (char *)buf+sofar, sz-sofar);
        if (rv == -1) {
            if (errno == EINTR || errno == EAGAIN) continue;
            perror("read error");
            exit(1);
        }
        if (rv == 0) exit(1);
        sofar += (size_t)rv;
    }
}
static void write_or_die(int fd, void *buf, size_t sz) {
    size_t sofar = 0;
    while (sofar < sz) {
        ssize_t rv = write(fd, (char *)buf+sofar, sz-sofar);
        if (rv == -1) {
            if (errno == EINTR || errno == EAGAIN) continue;
            perror("write error");
            exit(1);
        }
        if (rv == 0) exit(1);
        sofar += (size_t)rv;
    }
}

// documented somewhere in https://developer.chrome.com/docs/apps/nativeMessaging/
#define MAX_MESSAGE_SIZE (size_t)(1024*1024)

static int do_exchange(unsigned int id,
                       char **datap, size_t *sizep,
                       const char *fmt, ...) {
    *datap = NULL;
    *sizep = 0;

    char *jsonbuf = malloc(MAX_MESSAGE_SIZE);
    struct json_out out = JSON_OUT_BUF(jsonbuf, MAX_MESSAGE_SIZE);

    va_list args;
    va_start(args, fmt);
     size_t request_size = (size_t)json_vprintf(&out, fmt, args);
    va_end(args);
    if (request_size > MAX_MESSAGE_SIZE) {
        eprintln("warning: request too big to send (%zu > %zu)",
            request_size, MAX_MESSAGE_SIZE);
        free(jsonbuf);
        return -EMSGSIZE;
    }

    struct resumedata mydata = {
        .id = id,
        .msgpipe = {-1, -1},
        .data = NULL,
        .size = 0,
    };
    if (-1 == pipe(mydata.msgpipe)) {
        perror("exchange: pipe");
        free(jsonbuf);
        return -EIO;
    }

    pthread_mutex_lock(&write_lock);

    uint32_t size_4bytes = request_size;

    write_or_die(STDOUT_FILENO, &size_4bytes, sizeof(size_4bytes));
    write_or_die(STDOUT_FILENO, jsonbuf, request_size);

    free(jsonbuf); jsonbuf = NULL;

    waiters = realloc(waiters, (numwaiters+1)*sizeof(*waiters));
    waiters[numwaiters] = &mydata;
    numwaiters += 1;

    pthread_mutex_unlock(&write_lock);

    char c;
    read_or_die(mydata.msgpipe[0], &c, 1);

    // note: protecting this with the same lock fixes random fd-related crashes under cygwin
    pthread_mutex_lock(&write_lock);
    close(mydata.msgpipe[0]);
    close(mydata.msgpipe[1]);
    pthread_mutex_unlock(&write_lock);

    int err;
    if (1 == json_scanf(mydata.data, mydata.size, "{error: %d}", &err)) {
        free(mydata.data);
        return -err;
    }

    *datap = mydata.data;
    *sizep = mydata.size;

    return 0;
}

static void *reader_main(void *ud) {
    (void)ud;
    for (;;) {
        uint32_t size_4bytes;
        read_or_die(STDIN_FILENO, &size_4bytes, sizeof(size_4bytes));
        size_t insize = size_4bytes;

        char *data = malloc(insize);
        read_or_die(STDIN_FILENO, data, insize);

        unsigned int id;
        if (1 != json_scanf(data, insize, "{id: %u}", &id)) {
            eprintln("reader: warning: got a message without an id, ignoring");
            free(data);
            continue;
        }

        pthread_mutex_lock(&write_lock);
        int found = 0;
        unsigned int i = numwaiters;
        while (i --> 0) {
            if (waiters[i]->id == id) {
                char c = '!';
                waiters[i]->data = data;
                waiters[i]->size = insize;
                write_or_die(waiters[i]->msgpipe[1], &c, 1);
                memmove(&waiters[i], &waiters[i+1],
                    (numwaiters-(i+1))*sizeof(*waiters));
                numwaiters -= 1;
                found = 1;
                break;
            }
        }
        if (!found) {
            eprintln("reader: warning: got a message for nonexistent waiter %u", id);
            free(data);
        }
        pthread_mutex_unlock(&write_lock);
    }
    return NULL;
}

static int count_fmt_args(const char *s) {
    int cnt = 0;
    for (; *s; s++) {
        if (*s == '%') {
            if (*(s+1) != '%') cnt++;
            else s++;
        }
    }
    return cnt;
}

#define exchange_json(datap, sizep, keys_fmt, ...) \
    do { \
        unsigned int id = get_thread_id(); \
        int req_rv = do_exchange(id, datap, sizep, \
            "{id: %u, " keys_fmt "}", \
            id, ##__VA_ARGS__); \
        if (req_rv != 0) return req_rv; \
    } while (0)

#define parse_and_free_response(data, size, keys_fmt, ...) \
    do { \
        if (*keys_fmt == '\0') { \
            /* empty format string, skip the work */ \
            free(data); data = NULL; \
        } else { \
            int num_expected = count_fmt_args(keys_fmt); \
            int num_scanned = json_scanf(data, size, \
                "{" keys_fmt "}", \
                ##__VA_ARGS__); \
            if (num_scanned == num_expected) { \
                free(data); data = NULL; \
            } else { \
                eprintln("%s: could only parse %d of %d keys!", \
                    __func__, num_scanned, num_expected); \
                free(data); data = NULL; \
                return -EIO; \
            } \
        } \
    } while (0)

static int tabfs_getattr(const char *path, struct stat *stbuf) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q",
        "getattr", path);

    memset(stbuf, 0, sizeof(struct stat));
    parse_and_free_response(rdata, rsize,
        "st_mode: %d, st_nlink: %d, st_size: %d",
        &stbuf->st_mode, &stbuf->st_nlink, &stbuf->st_size);

#if defined(CYGFUSE)
    // user must be set for writing files to work under cygwin
    stbuf->st_uid = geteuid();
#endif

    return 0;
}

static int tabfs_readlink(const char *path, char *buf, size_t size) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q",
        "readlink", path);

    char *scan_buf;
    int scan_len;
    parse_and_free_response(rdata, rsize,
        "buf: %V",
        &scan_buf, &scan_len);

    // fuse.h:
    // "If the linkname is too long to fit in the buffer, it should be truncated."
    if ((size_t)scan_len >= size) scan_len = size-1;

    memcpy(buf, scan_buf, scan_len);
    buf[scan_len] = '\0';

    free(scan_buf);

    return 0;
}

static int tabfs_open(const char *path, struct fuse_file_info *fi) {
    char *data;
    size_t size;
    exchange_json(&data, &size,
        "op: %Q, path: %Q, flags: %d",
        "open", path, fi->flags);

    parse_and_free_response(data, size,
        "fh: %llu",
        &fi->fh);

    return 0;
}

static int tabfs_read(const char *path,
                      char *buf,
                      size_t size,
                      off_t offset,
                      struct fuse_file_info *fi) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, size: %d, offset: %lld, fh: %llu, flags: %d",
        "read", path, size, offset, fi->fh, fi->flags);

    char *scan_buf; int scan_len;
    parse_and_free_response(rdata, rsize,
        "buf: %V",
        &scan_buf, &scan_len);

    if ((size_t)scan_len > size) scan_len = size;
    memcpy(buf, scan_buf, scan_len);
    free(scan_buf);

    return scan_len;
}

static int tabfs_write(const char *path,
                       const char *data,
                       size_t size,
                       off_t offset,
                       struct fuse_file_info *fi) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, buf: %V, offset: %lld, fh: %llu, flags: %d",
        "write", path, data, size, offset, fi->fh, fi->flags);

    int ret;
    parse_and_free_response(rdata, rsize,
        "size: %d",
        &ret);

    return ret;
}

static int tabfs_release(const char *path, struct fuse_file_info *fi) {
    char *data;
    size_t size;
    exchange_json(&data, &size,
        "op: %Q, path: %Q, fh: %llu",
        "release", path, fi->fh);

    parse_and_free_response(data, size, "");

    return 0;
}

static int tabfs_opendir(const char *path, struct fuse_file_info *fi) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, flags: %d",
        "opendir", path, fi->flags);

    parse_and_free_response(rdata, rsize,
        "fh: %llu",
        &fi->fh);

    return 0;
}

static int tabfs_readdir(const char *path,
                         void *buf,
                         fuse_fill_dir_t filler,
                         off_t offset,
                         struct fuse_file_info *fi) {
    (void)fi;

    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, offset: %lld",
        "readdir", path, offset);

    struct json_token t;
    for (int i = 0; json_scanf_array_elem(rdata, rsize, ".entries", i, &t) > 0; i++) {
        char entry[t.len+1];
        memcpy(entry, t.ptr, t.len);
        entry[t.len] = '\0';
        filler(buf, entry, NULL, 0);
    }

    parse_and_free_response(rdata, rsize, "");

    return 0;
}

static int tabfs_releasedir(const char *path, struct fuse_file_info *fi) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, fh: %llu",
        "releasedir", path, fi->fh);

    parse_and_free_response(rdata, rsize, "");

    return 0;
}

static int tabfs_truncate(const char *path, off_t size) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, size: %lld",
        "truncate", path, size);

    parse_and_free_response(rdata, rsize, "");

    return 0;
}

static int tabfs_unlink(const char *path) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q",
        "unlink", path);

    parse_and_free_response(rdata, rsize, "");

    return 0;
}

static int tabfs_mkdir(const char *path, mode_t mode) {
    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, mode: %d",
        "mkdir", path, mode);

    parse_and_free_response(rdata, rsize, "");

    return 0;
}

static int tabfs_mknod(const char *path, mode_t mode, dev_t rdev) {
    (void)rdev;

    char *rdata;
    size_t rsize;
    exchange_json(&rdata, &rsize,
        "op: %Q, path: %Q, mode: %d",
        "mknod", path, mode);

    parse_and_free_response(rdata, rsize, "");

    return 0;
}

static const struct fuse_operations tabfs_oper = {
    .getattr  = tabfs_getattr,
    .readlink = tabfs_readlink,

    .open    = tabfs_open,
    .read    = tabfs_read,
    .write   = tabfs_write,
    .release = tabfs_release,

    .opendir    = tabfs_opendir,
    .readdir    = tabfs_readdir,
    .releasedir = tabfs_releasedir,

    .truncate = tabfs_truncate,
    .unlink   = tabfs_unlink,

    .mkdir  = tabfs_mkdir,
    .mknod = tabfs_mknod,
};

int main(int argc, char **argv) {
    (void)argc;
    if (NULL == getenv("TABFS_MOUNT_DIR")) {
        setenv("TABFS_MOUNT_DIR", "mnt", 1);
    }

    freopen("log.txt", "a", stderr);
    setvbuf(stderr, NULL, _IONBF, 0);

#if !defined(CYGFUSE)
    char killcmd[128];
    sprintf(killcmd, "pgrep tabfs | grep -v %d | xargs kill -9 2>/dev/null", getpid());
    system(killcmd);

#if defined(__APPLE__)
    system("diskutil umount force \"$TABFS_MOUNT_DIR\" >/dev/null");
#elif defined(__FreeBSD__)
    system("umount -f \"$TABFS_MOUNT_DIR\" 2>/dev/null");
#else
    system("fusermount -u \"$TABFS_MOUNT_DIR\" 2>/dev/null");
#endif

    system("mkdir -p \"$TABFS_MOUNT_DIR\"");
#endif

#if defined(CYGFUSE)
    // winfsp-fuse needs to create the mount directory itself
    // try to remove it using rmdir (will work if it's empty)
    if (0 == access(getenv("TABFS_MOUNT_DIR"), R_OK) &&
        0 != rmdir(getenv("TABFS_MOUNT_DIR"))) {
        eprintln("error: the mount directory \"%s\" already exists!", getenv("TABFS_MOUNT_DIR"));
        return 1;
    }
#endif

    pthread_t thread;
    int err = pthread_create(&thread, NULL, reader_main, NULL);
    if (err != 0) {
        eprintln("pthread_create: %s", strerror(err));
        exit(1);
    }

    pthread_detach(thread);

    char *fuse_argv[] = {
        argv[0],
        "-f",
#if !defined(__APPLE__)
#if !defined(__FreeBSD__)
        "-oauto_unmount",
#endif
#endif
        "-odirect_io",
        getenv("TABFS_MOUNT_DIR"),
        NULL,
    };
    return fuse_main(
        (sizeof(fuse_argv)/sizeof(*fuse_argv))-1,
        (char **)&fuse_argv,
        &tabfs_oper,
        NULL);
}
