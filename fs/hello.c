#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>
#include <fuse.h>

#define WBY_STATIC
#define WBY_IMPLEMENTATION
#define WBY_USE_FIXED_TYPES
#define WBY_USE_ASSERT
#include "mmx/web.h"

#include "cJSON/cJSON.h"
#include "cJSON/cJSON.c"

struct wby_server server;
struct wby_con *con;

enum opcode {
    NONE = 0,

    GETATTR,
    READDIR
};

struct readdir {
    char **entries;
    size_t num_entries;
};

struct response {
    enum opcode op;

    int error;

    union {
        struct stat getattr;
        struct readdir readdir;
    } body;
};

pthread_cond_t response_cv = PTHREAD_COND_INITIALIZER;
pthread_mutex_t response_mutex = PTHREAD_MUTEX_INITIALIZER;

struct response response = (struct response) { .op = NONE };

static const char  *file_path      = "/hello.txt";
static const char   file_content[] = "Hello World!\n";
static const size_t file_size      = sizeof(file_content)/sizeof(char) - 1;

static void send_req(cJSON *req) {
  char *data = cJSON_Print(req);
  printf("%s\n", data);

  wby_frame_begin(con, WBY_WSOP_TEXT_FRAME);
  wby_write(con, data, strlen(data));
  wby_frame_end(con);

  free(data);
}

#define MAKE_REQ(op, body) \
  do { \
    cJSON *req = cJSON_CreateObject(); \
    cJSON_AddNumberToObject(req, "op", (int) op);        \
    body \
    send_req(req); \
    cJSON_Delete(req); \
} while (0)

static struct response await_response(enum opcode op) {
  pthread_mutex_lock(&response_mutex);

  memset(&response, 0, sizeof response);
  while (response.op == NONE) {
    pthread_cond_wait(&response_cv, &response_mutex);
  }

  struct response ret = response;
  pthread_mutex_unlock(&response_mutex);

  return ret;
}

static int
hello_getattr(const char *path, struct stat *stbuf)
{
    memset(stbuf, 0, sizeof(struct stat));
    printf("\n\ngetattr(%s)\n", path);

    MAKE_REQ(GETATTR, {
        cJSON_AddStringToObject(req, "path", path);
      });

    struct response resp = await_response(GETATTR);
    if (resp.error != 0) {
      printf("error re getattr(%s): %d\n", path, resp.error);
      return -resp.error;
    }

    stbuf->st_mode = resp.body.getattr.st_mode;
    stbuf->st_nlink = resp.body.getattr.st_nlink;
    stbuf->st_size = resp.body.getattr.st_size;
    printf("returning re getattr(%s)\n", path);
    /* if (strcmp(path, "/") == 0) { /\* The root directory of our file system. *\/ */
    /*     stbuf->st_mode = S_IFDIR | 0755; */
    /*     stbuf->st_nlink = 3; */
    /* } else if (strcmp(path, file_path) == 0) { /\* The only file we have. *\/ */
    /*     stbuf->st_mode = S_IFREG | 0444; */
    /*     stbuf->st_nlink = 1; */
    /*     stbuf->st_size = file_size; */
    /* } else /\* We reject everything else. *\/ */
    /*     return -ENOENT; */


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
    printf("\n\nreaddir(%s)\n", path);

    // send {op: "readdir", path} to the websocket handler
    MAKE_REQ(READDIR, {
        cJSON_AddStringToObject(req, "path", path);
      });

    printf("awaiting response to readdir(%s)\n", path);
    struct response resp = await_response(READDIR);

    struct readdir *readdir = &resp.body.readdir;
    printf("response: %d files\n", (int) readdir->num_entries);

    for (size_t i = 0; i < readdir->num_entries; ++i) {
        filler(buf, readdir->entries[i], NULL, 0);
        printf("entry: [%s]\n", readdir->entries[i]);
    }

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
    /* connection bound userdata */
    connection->user_data = NULL;
    if (0 == strcmp(connection->request.uri, "/"))
        return 0;
    return 1;
}

static void
websocket_connected(struct wby_con *connection, void *userdata)
{
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

    pthread_mutex_lock(&response_mutex);

    cJSON *ret = cJSON_Parse((const char *) data);

    cJSON *op_item = cJSON_GetObjectItemCaseSensitive(ret, "op");
    response.op = (enum opcode) op_item->valueint;

    cJSON *error_item = cJSON_GetObjectItemCaseSensitive(ret, "error");
    if (error_item) {
      response.error = error_item->valueint;
      if (response.error != 0) goto done;
    }

    if (response.op == READDIR) {
      struct readdir *readdir = &response.body.readdir;

      cJSON *entries = cJSON_GetObjectItemCaseSensitive(ret, "entries");

      readdir->num_entries = cJSON_GetArraySize(entries);
      readdir->entries = malloc(sizeof(char *) * readdir->num_entries);

      int i = 0;
      cJSON *entry;
      cJSON_ArrayForEach(entry, entries) {
        readdir->entries[i++] = strdup(cJSON_GetStringValue(entry));
      }

    } else if (response.op == GETATTR) {
      struct stat *getattr = &response.body.getattr;
      getattr->st_mode = cJSON_GetObjectItemCaseSensitive(ret, "st_mode")->valueint;
      getattr->st_nlink = cJSON_GetObjectItemCaseSensitive(ret, "st_nlink")->valueint;
      getattr->st_size = cJSON_GetObjectItemCaseSensitive(ret, "st_size")->valueint;
    }

 done:
    if (ret) cJSON_Delete(ret);

    pthread_cond_signal(&response_cv);
    pthread_mutex_unlock(&response_mutex);
    return 0;
}

static void
websocket_closed(struct wby_con *connection, void *userdata)
{
    printf("WebSocket closed\n");
}

static void
test_log(const char* text)
{
    printf("[debug] %s\n", text);
}

void *websocket_main(void *threadid)
{
    void *memory = NULL;
    wby_size needed_memory = 0;

    struct wby_config config;
    memset(&config, 0, sizeof config);
    config.userdata = NULL;
    config.address = "127.0.0.1";
    config.port = 8888;
    config.connection_max = 4;
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

    printf("Awaiting WebSocket connection from Chrome extension.\n");
    for (;;) {
        wby_update(&server);
    }

    wby_stop(&server);
    free(memory);
#if defined(_WIN32)
    WSACleanup();
#endif
    return 0;
}

int
main(int argc, char **argv)
{
    pthread_t websocket_thread;
    pthread_create(&websocket_thread, NULL, websocket_main, NULL);
    return fuse_main(argc, argv, &hello_filesystem_operations, NULL);

}
