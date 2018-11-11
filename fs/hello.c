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

#include "cJSON/cJSON.h"
#include "cJSON/cJSON.c"

#define MAX_WSCONN 8
struct server_state {
    int quit;
    unsigned frame_counter;
    struct wby_con *conn[MAX_WSCONN];
    int conn_count;
};

struct wby_server server;
struct wby_con *con;

typedef struct response_readdir_t {
  char **entries;
  size_t num_entries;
} response_readdir_t;

response_readdir_t *response;

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

    // send [READDIR, path] to the websocket handler
    {
      char *data;
      {
        cJSON *req = cJSON_CreateObject();
        cJSON_AddStringToObject(req, "op", "readdir");
        cJSON_AddStringToObject(req, "path", path);

        data = cJSON_Print(req);
        printf("%s\n", data);

        cJSON_Delete(req);
      }

      wby_frame_begin(con, WBY_WSOP_TEXT_FRAME);
      wby_write(con, data, strlen(data));
      wby_frame_end(con);

      free(data);
    }

    if (response) free(response);
    response = NULL;
    do {
        wby_update(&server);
    } while (response == NULL);

    printf("response: %d files\n", response->num_entries);

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
    return 1;
}

static int
websocket_connect(struct wby_con *connection, void *userdata)
{
    /* Allow websocket upgrades on /wstest */
    struct server_state *state = (struct server_state*)userdata;
    /* connection bound userdata */
    connection->user_data = NULL;
    if (0 == strcmp(connection->request.uri, "/") && state->conn_count < MAX_WSCONN)
        return 0;
    else return 1;
}

static void
websocket_connected(struct wby_con *connection, void *userdata)
{
    struct server_state *state = (struct server_state*)userdata;
    printf("WebSocket connected\n");
    con = connection;
}

static int
websocket_frame(struct wby_con *connection, const struct wby_frame *frame, void *userdata)
{
    unsigned char data[1024] = {0};

    int i = 0;
    printf("WebSocket frame incoming\n");
    printf("  Frame OpCode: %d\n", frame->opcode);
    printf("  Final frame?: %s\n", (frame->flags & WBY_WSF_FIN) ? "yes" : "no");
    printf("  Masked?     : %s\n", (frame->flags & WBY_WSF_MASKED) ? "yes" : "no");
    printf("  Data Length : %d\n", (int) frame->payload_length);

    if ((unsigned long) frame->payload_length > sizeof(data)) {
        printf("Data too long!\n");
    }
    
    while (i < frame->payload_length) {
        unsigned char buffer[16];
        int remain = frame->payload_length - i;
        size_t read_size = remain > (int) sizeof buffer ? sizeof buffer : (size_t) remain;
        size_t k;

        printf("%08x ", (int) i);
        if (0 != wby_read(connection, buffer, read_size))
            break;
        for (k = 0; k < read_size; ++k)
            printf("%02x ", buffer[k]);
        for (k = read_size; k < 16; ++k)
            printf("   ");
        printf(" | ");
        for (k = 0; k < read_size; ++k)
            printf("%c", isprint(buffer[k]) ? buffer[k] : '?');
        printf("\n");
        for (k = 0; k < read_size; ++k)
          data[i + k] = buffer[k];
        i += (int)read_size;
    }

    if ((int) strlen((const char *) data) != frame->payload_length) {
      printf("Null in data! [%s]\n", data);
    }

    cJSON *ret = cJSON_Parse((const char *) data);
    cJSON *op = cJSON_GetObjectItemCaseSensitive(ret, "op");
    if (strcmp(op->valuestring, "readdir") == 0) {
      response = malloc(sizeof(response));
      response->entries = malloc(sizeof(char *) * 10);
      response->entries[0] = "a";
      response->entries[1] = "b";
      response->num_entries = 2;
    }

    return 0;
}

static void
websocket_closed(struct wby_con *connection, void *userdata)
{
    int i;
    struct server_state *state = (struct server_state*)userdata;
    printf("WebSocket closed\n");
    for (i = 0; i < state->conn_count; i++) {
        if (state->conn[i] == connection) {
            int remain = state->conn_count - i;
            memmove(state->conn + i, state->conn + i + 1, (size_t)remain * sizeof(struct wby_con*));
            --state->conn_count;
            break;
        }
    }
}

static void
test_log(const char* text)
{
    printf("[debug] %s\n", text);
}

int
main(int argc, char **argv)
{
  void *memory = NULL;
    wby_size needed_memory = 0;
    struct server_state state;

    struct wby_config config;
    memset(&config, 0, sizeof config);
    config.userdata = &state;
    config.address = "127.0.0.1";
    config.port = 8888;
    config.connection_max = 1;
    config.request_buffer_size = 2048;
    config.io_buffer_size = 8192;
    config.log = test_log;
    config.dispatch = dispatch;
    config.ws_connect = websocket_connect;
    config.ws_connected = websocket_connected;
    config.ws_frame = websocket_frame;
    config.ws_closed = websocket_closed;
    
    wby_init(&server, &config, &needed_memory);
    memory = calloc(needed_memory, 1);
    wby_start(&server, memory);

    memset(&state, 0, sizeof state);

    printf("Awaiting WebSocket connection from Chrome extension.\n");
    while (con == NULL) {
        wby_update(&server);
    }
    return fuse_main(argc, argv, &hello_filesystem_operations, NULL);
/*     wby_stop(&server); */
/*     free(memory); */
/* #if defined(_WIN32) */
/*     WSACleanup(); */
/* #endif */
/*     return 0; */
  // 
}
