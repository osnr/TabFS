#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <stdlib.h>
#include <fuse.h>

#define WBY_STATIC
#define WBY_IMPLEMENTATION
#define WBY_USE_FIXED_TYPES
#define WBY_USE_ASSERT
#include "mmx/web.h"


#define MAX_WSCONN 8
struct server_state {
    int quit;
    unsigned frame_counter;
    struct wby_con *conn[MAX_WSCONN];
    int conn_count;
};


static const char  *file_path      = "/hello.txt";
static const char   file_content[] = "Hello World!\n";
static const size_t file_size      = sizeof(file_content)/sizeof(char) - 1;

static int
hello_getattr(const char *path, struct stat *stbuf)
{
    memset(stbuf, 0, sizeof(struct stat));

    if (strcmp(path, "/") == 0) { /* The root directory of our file system. */
        stbuf->st_mode = S_IFDIR | 0755;
        stbuf->st_nlink = 3;
    } else if (strcmp(path, file_path) == 0) { /* The only file we have. */
        stbuf->st_mode = S_IFREG | 0444;
        stbuf->st_nlink = 1;
        stbuf->st_size = file_size;
    } else /* We reject everything else. */
        return -ENOENT;

    return 0;
}

static int
hello_open(const char *path, struct fuse_file_info *fi)
{
    if (strcmp(path, file_path) != 0) /* We only recognize one file. */
        return -ENOENT;

    if ((fi->flags & O_ACCMODE) != O_RDONLY) /* Only reading allowed. */
        return -EACCES;

    return 0;
}

static int
hello_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
              off_t offset, struct fuse_file_info *fi)
{
    if (strcmp(path, "/") != 0) /* We only recognize the root directory. */
        return -ENOENT;

    filler(buf, ".", NULL, 0);           /* Current directory (.)  */
    filler(buf, "..", NULL, 0);          /* Parent directory (..)  */
    filler(buf, file_path + 1, NULL, 0); /* The only file we have. */

    return 0;
}

static int
hello_read(const char *path, char *buf, size_t size, off_t offset,
           struct fuse_file_info *fi)
{
    if (strcmp(path, file_path) != 0)
        return -ENOENT;

    if (offset >= file_size) /* Trying to read past the end of file. */
        return 0;

    if (offset + size > file_size) /* Trim the read to the file size. */
        size = file_size - offset;

    memcpy(buf, file_content + offset, size); /* Provide the content. */

    return size;
}

static struct fuse_operations hello_filesystem_operations = {
    .getattr = hello_getattr, /* To provide size, permissions, etc. */
    .open    = hello_open,    /* To enforce read-only access.       */
    .read    = hello_read,    /* To provide file content.           */
    .readdir = hello_readdir, /* To provide directory listing.      */
};

static int
dispatch(struct wby_con *connection, void *userdata)
{
    struct server_state *state = (struct server_state*)userdata;
    if (!strcmp("/foo", connection->request.uri)) {
        wby_response_begin(connection, 200, 14, NULL, 0);
        wby_write(connection, "Hello, world!\n", 14);
        wby_response_end(connection);
        return 0;
    } else if (!strcmp("/bar", connection->request.uri)) {
        wby_response_begin(connection, 200, -1, NULL, 0);
        wby_write(connection, "Hello, world!\n", 14);
        wby_write(connection, "Hello, world?\n", 14);
        wby_response_end(connection);
        return 0;
    } else if (!strcmp("/quit", connection->request.uri)) {
        wby_response_begin(connection, 200, -1, NULL, 0);
        wby_write(connection, "Goodbye, cruel world\n", 22);
        wby_response_end(connection);
        state->quit = 1;
        return 0;
    } else return 1;
}

int
main(int argc, char **argv)
{
      void *memory = NULL;
    wby_size needed_memory = 0;
    struct server_state state;
    struct wby_server server;

    struct wby_config config;
    memset(&config, 0, sizeof config);
    config.userdata = &state;
    config.address = "127.0.0.1";
    config.port = 8888;
    config.connection_max = 4;
    config.request_buffer_size = 2048;
    config.io_buffer_size = 8192;
    /* config.log = test_log; */
    config.dispatch = dispatch;
    /* config.ws_connect = websocket_connect; */
    /* config.ws_connected = websocket_connected; */
    /* config.ws_frame = websocket_frame; */
    /* config.ws_closed = websocket_closed; */

#if defined(_WIN32)
    {WORD wsa_version = MAKEWORD(2,2);
    WSADATA wsa_data;
    if (WSAStartup(wsa_version, &wsa_data)) {
        fprintf(stderr, "WSAStartup failed\n");
        return 1;
    }}
#endif

    wby_init(&server, &config, &needed_memory);
    memory = calloc(needed_memory, 1);
    wby_start(&server, memory);

    memset(&state, 0, sizeof state);
    while (!state.quit) {
        int i = 0;
        wby_update(&server);
        /* Push some test data over websockets */
        if (!(state.frame_counter & 0x7f)) {
            for (i = 0; i < state.conn_count; ++i) {
                wby_frame_begin(state.conn[i], WBY_WSOP_TEXT_FRAME);
                wby_write(state.conn[i], "Hello world over websockets!\n", 29);
                wby_frame_end(state.conn[i]);
            }
        }
        /* sleep_for(30); */
        ++state.frame_counter;
    }
    wby_stop(&server);
    free(memory);
#if defined(_WIN32)
    WSACleanup();
#endif
    return 0;
  // return fuse_main(argc, argv, &hello_filesystem_operations, NULL);
}
