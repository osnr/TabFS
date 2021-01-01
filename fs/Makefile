TARGETS = tabfs

# Root for OSXFUSE includes and libraries
OSXFUSE_ROOT = /usr/local
#OSXFUSE_ROOT = /opt/local

CFLAGS_EXTRA = -DFUSE_USE_VERSION=26 -D_FILE_OFFSET_BITS=64 -Wall -Wno-unused-function -g

ifeq ($(shell uname -s),Linux)
	CFLAGS += $(CFLAGS_EXTRA)
	LIBS = -lfuse
endif
ifeq ($(shell uname -s),Darwin)
	CFLAGS = -I$(OSXFUSE_ROOT)/include/osxfuse/fuse -L$(OSXFUSE_ROOT)/lib -D_DARWIN_USE_64_BIT_INODE $(CFLAGS)
	LIBS = -losxfuse
endif

all: $(TARGETS)

tabfs: tabfs.c
	cc $(CFLAGS) -o $@ $^ $(LIBS)

clean:
	rm -f $(TARGETS) *.o
	rm -rf *.dSYM

unmount:
	killall -9 tabfs || true
	diskutil unmount force mnt || true
