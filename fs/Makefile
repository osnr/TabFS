TARGETS = tabfs

# Root for OSXFUSE includes and libraries
OSXFUSE_ROOT = /usr/local
#OSXFUSE_ROOT = /opt/local

INCLUDE_DIR = $(OSXFUSE_ROOT)/include/osxfuse/fuse
LIBRARY_DIR = $(OSXFUSE_ROOT)/lib

CC ?= gcc

CFLAGS_OSXFUSE = -I$(INCLUDE_DIR) -L$(LIBRARY_DIR)
CFLAGS_OSXFUSE += -DFUSE_USE_VERSION=26
CFLAGS_OSXFUSE += -D_FILE_OFFSET_BITS=64
CFLAGS_OSXFUSE += -D_DARWIN_USE_64_BIT_INODE

CFLAGS_EXTRA = -Wall -g $(CFLAGS)

LIBS = -losxfuse

all: $(TARGETS)

tabfs: common.c ws.c tabfs.c
	$(CC) $(CFLAGS_OSXFUSE) $(CFLAGS_EXTRA) -o $@ $^ $(LIBS)

clean:
	rm -f $(TARGETS) *.o
	rm -rf *.dSYM

unmount:
	killall -9 hello || true
	diskutil unmount force mnt || true

mount: tabfs
	./tabfs -odirect_io -s -f mnt

debugmount: tabfs
	lldb -- ./tabfs -odirect_io -s -f mnt
