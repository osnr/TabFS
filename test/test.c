#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>

#include <unistd.h>
#include <assert.h>
#include <wordexp.h>

int file_contents_equal(char* path, char* contents) {
    // hehe: https://twitter.com/ianh_/status/1340450349065244675
    setenv("path", path, 1);
    setenv("contents", contents, 1);
    return system("[ \"$contents\" == \"$(cat \"$path\")\" ]") == 0;
}

char* expand(char* phrase) { // expand path with wildcard
    wordexp_t result; assert(wordexp(phrase, &result, 0) == 0);
    return result.we_wordv[0];
}

// integration tests
int main() {
    // if you don't have node, comment this out, I guess:
    assert(system("node ../extension/background.js --unhandled-rejections=strict") == 0); // run quick local JS tests

    // reload the extension so we know it's the latest code.
    system("echo reload > ../fs/mnt/runtime/reload 2>/dev/null"); // this may error, but it should still have effect
    // spin until the extension reloads.
    struct stat st; while (stat("../fs/mnt/tabs", &st) != 0) {}

    assert(file_contents_equal(expand("../fs/mnt/extensions/TabFS*/enabled"), "true"));

    {
        assert(system("echo about:blank > ../fs/mnt/tabs/create") == 0);
        // FIXME: race here?
        assert(file_contents_equal("../fs/mnt/tabs/last-focused/url.txt", "about:blank"));
        assert(system("echo remove > ../fs/mnt/tabs/last-focused/control") == 0);
    }

    {
        assert(system("echo file://$(pwd)/test-page.html > ../fs/mnt/tabs/create") == 0);
        assert(file_contents_equal("../fs/mnt/tabs/last-focused/title.txt", "Title of Test Page"));
        assert(file_contents_equal("../fs/mnt/tabs/last-focused/text.txt", "Body Text of Test Page"));
        assert(system("echo remove > ../fs/mnt/tabs/last-focused/control") == 0);
    }

    assert(1); printf("Done!\n"); 
}
