#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>
#include <fuse.h>

#include "cJSON/cJSON.h"
#include "cJSON/cJSON.c"

#include "base64/base64.h"
#include "base64/base64.c"

#include "common.h"
#include "ws.h"

static cJSON *send_request_then_await_response(cJSON *req) {
    // Will be freed at receiver (ws.c, receive_tabfs_request_then_send_to_browser).
    char *request_data = cJSON_Print(req);
    common_send_tabfs_to_ws(request_data);

    char *response_data = common_receive_ws_to_tabfs();
    if (response_data == NULL) {
        // Connection is dead.
        return cJSON_Parse("{ \"error\": 5 }");
    }

    cJSON *resp = cJSON_Parse((const char *) response_data);
    // Was allocated by sender (ws.c, websocket_frame).
    free(response_data);

    return resp;
}

#define MAKE_REQ(OP, REQ_BUILDER_BODY, RESP_HANDLER_BODY)       \
    do {                                              \
        int ret = -1;                                 \
        cJSON *req = NULL;                                              \
        cJSON *resp = NULL;                                             \
                                                                        \
        req = cJSON_CreateObject();                                     \
        cJSON_AddStringToObject(req, "op", OP);                         \
        REQ_BUILDER_BODY                                                \
                                                                        \
        resp = send_request_then_await_response(req);                   \
                                                                        \
        cJSON *error_item = cJSON_GetObjectItemCaseSensitive(resp, "error"); \
        if (error_item) {                                               \
            ret = -error_item->valueint;                                \
            if (ret != 0) goto done;                                    \
        }                                                               \
                                                                        \
        ret = -1;                                                       \
        RESP_HANDLER_BODY                                               \
                                                                        \
    done:                                                       \
        if (req != NULL) cJSON_Delete(req);                     \
        if (resp != NULL) cJSON_Delete(resp);                       \
        return ret;                                             \
    } while (0)

#define JSON_GET_PROP_INT(LVALUE, KEY) \
    do { \
        LVALUE = cJSON_GetObjectItemCaseSensitive(resp, KEY)->valueint;     \
    } while (0)

static int tabfs_getattr(const char *path, struct stat *stbuf) {
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

static int tabfs_readlink(const char *path, char *buf, size_t size) {
    MAKE_REQ("readlink", {
        cJSON_AddStringToObject(req, "path", path);
    }, {
        cJSON *resp_buf_item = cJSON_GetObjectItemCaseSensitive(resp, "buf");
        // FIXME: fix
        char *resp_buf = cJSON_GetStringValue(resp_buf_item);
        size_t resp_buf_len = strlen(resp_buf);
        size = resp_buf_len < size ? resp_buf_len : size;

        memcpy(buf, resp_buf, size);

        ret = size;
    });
}

static int tabfs_open(const char *path, struct fuse_file_info *fi) {
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
tabfs_read(const char *path, char *buf, size_t size, off_t offset,
           struct fuse_file_info *fi) {
    MAKE_REQ("read", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "size", size);
        cJSON_AddNumberToObject(req, "offset", offset);

        cJSON_AddNumberToObject(req, "fh", fi->fh);
        cJSON_AddNumberToObject(req, "flags", fi->flags);
    }, {
        cJSON *resp_buf_item = cJSON_GetObjectItemCaseSensitive(resp, "buf");
        if (!resp_buf_item) return -EIO;

        char *resp_buf = cJSON_GetStringValue(resp_buf_item);
        if (!resp_buf) return -EIO;
        size_t resp_buf_len = strlen(resp_buf);

        cJSON *base64_encoded_item = cJSON_GetObjectItemCaseSensitive(resp, "base64Encoded");
        if (base64_encoded_item && cJSON_IsTrue(base64_encoded_item)) {
            size = base64_decode(resp_buf, resp_buf_len, (unsigned char *) buf);
        } else {
            size = resp_buf_len < size ? resp_buf_len : size;
            memcpy(buf, resp_buf, size);
        }
        ret = size;
    });
}

static int tabfs_release(const char *path, struct fuse_file_info *fi) {
    MAKE_REQ("release", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "fh", fi->fh);
    }, {
        ret = 0;
    });
}

static int tabfs_opendir(const char *path, struct fuse_file_info *fi) {
    MAKE_REQ("opendir", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "flags", fi->flags);
    }, {
        cJSON *fh_item = cJSON_GetObjectItemCaseSensitive(resp, "fh");
        if (fh_item) fi->fh = fh_item->valueint;

        ret = 0;
    });
}

static int
tabfs_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
              off_t offset, struct fuse_file_info *fi) {
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
tabfs_releasedir(const char *path, struct fuse_file_info *fi) {
    MAKE_REQ("releasedir", {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "fh", fi->fh);
    }, {
        ret = 0;
    });
}

static struct fuse_operations tabfs_filesystem_operations = {
    .getattr  = tabfs_getattr, /* To provide size, permissions, etc. */
    .readlink = tabfs_readlink,
    .open     = tabfs_open,    /* To enforce read-only access.       */
    .read     = tabfs_read,    /* To provide file content.           */
    .release  = tabfs_release,

    .opendir  = tabfs_opendir,
    .readdir  = tabfs_readdir, /* To provide directory listing.      */
    .releasedir = tabfs_releasedir
};

int
main(int argc, char **argv)
{
    common_init();

    pthread_t websocket_thread;
    pthread_create(&websocket_thread, NULL, websocket_main, NULL);

    return fuse_main(argc, argv, &tabfs_filesystem_operations, NULL);
}
