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

#define DEBUG(...)

struct wby_server server;
struct wby_con *con = NULL;

pthread_cond_t queue_cv = PTHREAD_COND_INITIALIZER;
pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;

enum request_response_state {
  EMPTY = 0,
  SEND_REQUEST,
  RECEIVE_RESPONSE,
  HANDLE_RESPONSE
};

struct request_response {
  enum request_response_state state;

  char *request;
  cJSON *response;

  clock_t start;
};

#define REQUEST_RESPONSE_QUEUE_SIZE 128
typedef int request_id;
struct request_response queue[REQUEST_RESPONSE_QUEUE_SIZE];

static request_id enqueue_request(cJSON *req) {
  pthread_mutex_lock(&queue_mutex);

  // Look for the first free slot.
  request_id id;
  for (id = 0; id < REQUEST_RESPONSE_QUEUE_SIZE; id++) {
    if (queue[id].state == EMPTY) break;
  }
  if (id >= REQUEST_RESPONSE_QUEUE_SIZE) {
    printf("Request-response queue is full!\n");
    exit(1);
  }
  cJSON_AddNumberToObject(req, "id", id);

  queue[id].state = SEND_REQUEST;
  queue[id].request = cJSON_Print(req);
  queue[id].response = NULL;
  queue[id].start = clock();

  /* printf("%s\n", queue[id].request); */

  pthread_mutex_unlock(&queue_mutex);

  return id;
}

void send_any_enqueued_requests() {
  pthread_mutex_lock(&queue_mutex);

  if (con == NULL) goto done;

  for (request_id id = 0; id < REQUEST_RESPONSE_QUEUE_SIZE; id++) {
    if (queue[id].state == SEND_REQUEST) {
      char *request = queue[id].request;

      wby_frame_begin(con, WBY_WSOP_TEXT_FRAME);
      wby_write(con, request, strlen(request));
      wby_frame_end(con);

      queue[id].state = RECEIVE_RESPONSE;
      free(request);
      queue[id].request = NULL;
    }
  }

 done:
  pthread_mutex_unlock(&queue_mutex);
}

static cJSON *await_response(request_id id) {
  pthread_mutex_lock(&queue_mutex);

  while (queue[id].state != HANDLE_RESPONSE) {
    pthread_cond_wait(&queue_cv, &queue_mutex);
  }

  cJSON *resp = queue[id].response;
  queue[id].state = EMPTY;
  queue[id].response = NULL;

  /* printf("Elapsed: %f seconds\n", (double)(clock() - queue[id].start) / CLOCKS_PER_SEC); */

  pthread_mutex_unlock(&queue_mutex);

  return resp;
}

#define MAKE_REQ(op, req_body, resp_handler) \
  do { \
    int ret = -1;                                     \
    cJSON *req = NULL;                              \
    cJSON *resp = NULL;                           \
                                                  \
    pthread_mutex_lock(&queue_mutex); \
    int disconnected = (con == NULL); \
    pthread_mutex_unlock(&queue_mutex); \
    if (disconnected) { ret = -EIO; goto done; }        \
    \
    req = cJSON_CreateObject(); \
    cJSON_AddStringToObject(req, "op", op);        \
    req_body \
    \
    request_id id = enqueue_request(req); \
    resp = await_response(id);        \
    \
    cJSON *error_item = cJSON_GetObjectItemCaseSensitive(resp, "error"); \
    if (error_item) { \
      ret = -error_item->valueint; \
      if (ret != 0) goto done; \
    } \
    \
    ret = -1; \
    resp_handler \
    \
done: \
    if (req != NULL) cJSON_Delete(req); \
    if (resp != NULL) cJSON_Delete(resp); \
    return ret;                               \
  } while (0)

#define JSON_GET_PROP_INT(lvalue, key) \
  do { \
    lvalue = cJSON_GetObjectItemCaseSensitive(resp, key)->valueint;     \
  } while (0)

static int
hello_getattr(const char *path, struct stat *stbuf)
{
    memset(stbuf, 0, sizeof(struct stat));

    MAKE_REQ("getattr", {
        cJSON_AddStringToObject(req, "path", path);
    }, {
        JSON_GET_PROP_INT(stbuf->st_mode, "st_mode");
        JSON_GET_PROP_INT(stbuf->st_nlink, "st_nlink");
        JSON_GET_PROP_INT(stbuf->st_size, "st_size");

        ret = 0;
    });
}

static int
hello_open(const char *path, struct fuse_file_info *fi)
{
    MAKE_REQ("open", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "flags", fi->flags);
    }, {
        cJSON *fh_item = cJSON_GetObjectItemCaseSensitive(resp, "fh");
        if (fh_item) fi->fh = fh_item->valueint;

        ret = 0;
    });
}

static int
hello_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
              off_t offset, struct fuse_file_info *fi)
{
    // send {op: "readdir", path} to the websocket handler
    MAKE_REQ("readdir", {
        cJSON_AddStringToObject(req, "path", path);
    }, {
        cJSON *entries = cJSON_GetObjectItemCaseSensitive(resp, "entries");
        cJSON *entry;
        cJSON_ArrayForEach(entry, entries) {
            filler(buf, cJSON_GetStringValue(entry), NULL, 0);
        }

        ret = 0;
    });
}

static int
hello_read(const char *path, char *buf, size_t size, off_t offset,
           struct fuse_file_info *fi)
{
    MAKE_REQ("read", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "size", size);
        cJSON_AddNumberToObject(req, "offset", offset);

        cJSON_AddNumberToObject(req, "fh", fi->fh);
        cJSON_AddNumberToObject(req, "flags", fi->flags);
    }, {
        cJSON *resp_buf_item = cJSON_GetObjectItemCaseSensitive(resp, "buf");
        char *resp_buf = cJSON_GetStringValue(resp_buf_item);
        size_t resp_buf_len = strlen(resp_buf);
        size = resp_buf_len < size ? resp_buf_len : size;

        memcpy(buf, resp_buf, size);

        ret = size;
    });
}

static int hello_release(const char *path, struct fuse_file_info *fi) {
    MAKE_REQ("release", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "fh", fi->fh);
    }, {
        ret = 0;
    });
}

static struct fuse_operations hello_filesystem_operations = {
    .getattr = hello_getattr, /* To provide size, permissions, etc. */
    .open    = hello_open,    /* To enforce read-only access.       */
    .read    = hello_read,    /* To provide file content.           */
    .release = hello_release,
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
    unsigned char data[131072] = {0};

    int i = 0;
    DEBUG("WebSocket frame incoming\n");
    DEBUG("  Frame OpCode: %d\n", frame->opcode);
    DEBUG("  Final frame?: %s\n", (frame->flags & WBY_WSF_FIN) ? "yes" : "no");
    DEBUG("  Masked?     : %s\n", (frame->flags & WBY_WSF_MASKED) ? "yes" : "no");
    DEBUG("  Data Length : %d\n", (int) frame->payload_length);

    if ((unsigned long) frame->payload_length > sizeof(data)) {
        printf("Data too long!\n");
        exit(1);
    }
    
    while (i < frame->payload_length) {
        unsigned char buffer[16];
        int remain = frame->payload_length - i;
        size_t read_size = remain > (int) sizeof buffer ? sizeof buffer : (size_t) remain;
        size_t k;

        DEBUG("%08x ", (int) i);
        if (0 != wby_read(connection, buffer, read_size))
            break;
        for (k = 0; k < read_size; ++k)
            DEBUG("%02x ", buffer[k]);
        for (k = read_size; k < 16; ++k)
            DEBUG("   ");
        DEBUG(" | ");
        for (k = 0; k < read_size; ++k)
            DEBUG("%c", isprint(buffer[k]) ? buffer[k] : '?');
        DEBUG("\n");
        for (k = 0; k < read_size; ++k)
          data[i + k] = buffer[k];
        i += (int)read_size;
    }

    if ((int) strlen((const char *) data) != frame->payload_length) {
      printf("Null in data! [%s]\n", data);
    }

    // Will be freed at the receiver end.
    cJSON *resp = cJSON_Parse((const char *) data);

    cJSON *id_item = cJSON_GetObjectItemCaseSensitive(resp, "id");
    if (id_item == NULL) {
      printf("No id in response!\n");
      exit(1);
    }
    request_id id = id_item->valueint;

    pthread_mutex_lock(&queue_mutex);

    if (queue[id].state != RECEIVE_RESPONSE) {
      printf("Got response to request in wrong state!\n");
      exit(1);
    }
    queue[id].state = HANDLE_RESPONSE;
    queue[id].response = resp;

    pthread_cond_signal(&queue_cv);
    pthread_mutex_unlock(&queue_mutex);

    return 0;
}

static void
websocket_closed(struct wby_con *connection, void *userdata)
{
    printf("WebSocket closed\n");
    con = NULL;
}

static void
test_log(const char* text)
{
    DEBUG("[debug] %s\n", text);
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
        send_any_enqueued_requests();

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
