#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <dirent.h>
#include <string.h>

#include <unistd.h>
#include <assert.h>
#include <wordexp.h>
#include <regex.h>

int file_contents_equal(char* path, char* contents) {
    // hehe: https://twitter.com/ianh_/status/1340450349065244675
    setenv("path", path, 1);
    setenv("contents", contents, 1);
    return system("bash -c '[ \"$contents\" == \"$(cat \"$path\")\" ]'") == 0;
}

char* expand(char* phrase) { // expand path with wildcard
    wordexp_t result; assert(wordexp(phrase, &result, 0) == 0);
    return result.we_wordv[0];
}

int matches_regex(char* str, char* pattern) {
    regex_t re; assert(regcomp(&re, pattern, REG_EXTENDED) == 0);
    int i = regexec(&re, str, 0, NULL, 0);
    regfree(&re);
    return i == 0;
}

// integration tests
int main() {
    // TODO: invoke over extension
    /* assert(system("node ../extension/background.js --unhandled-rejections=strict") == 0); // run quick local JS tests */

    // reload the extension so we know it's the latest code.
    system("echo reload > ../fs/mnt/runtime/reload 2>/dev/null"); // this may error, but it should still have effect
    // spin until the extension reloads.
    struct stat st; while (stat("../fs/mnt/tabs", &st) != 0) {}

    assert(file_contents_equal(expand("../fs/mnt/extensions/TabFS*/enabled"), "true"));

    {
        assert(system("echo about:blank > ../fs/mnt/tabs/create") == 0);
        int times = 0;
        for (;;) {
            if (file_contents_equal("../fs/mnt/tabs/last-focused/url.txt", "about:blank")) {
                break;
            }
            usleep(10000);
            assert(times++ < 10000);
        }

        assert(system("echo remove > ../fs/mnt/tabs/last-focused/control") == 0);
    }

    {
        assert(system("echo file://$(pwd)/test-page.html > ../fs/mnt/tabs/create") == 0);
        assert(file_contents_equal("../fs/mnt/tabs/last-focused/title.txt", "Title of Test Page"));
        assert(file_contents_equal("../fs/mnt/tabs/last-focused/text.txt", "Body Text of Test Page"));

        assert(system("ls ../fs/mnt/tabs/last-focused/debugger/scripts") == 0);

        {
            DIR* scripts = opendir("../fs/mnt/tabs/last-focused/debugger/scripts");
            assert(strcmp(readdir(scripts)->d_name, ".") == 0);
            assert(strcmp(readdir(scripts)->d_name, "..") == 0);
            assert(matches_regex(readdir(scripts)->d_name, "test\\-script.js$"));
            closedir(scripts);
        }
        assert(system("cat ../fs/mnt/tabs/last-focused/debugger/scripts/*test-script.js") == 0);

        {
            assert(system("echo '2 + 2' > ../fs/mnt/tabs/last-focused/evals/twoplustwo.js") == 0);

            FILE* result = fopen("../fs/mnt/tabs/last-focused/evals/twoplustwo.js.result", "r");
            char four[2] = {0}; fread(four, 1, 1, result);
            assert(strcmp(four, "4") == 0);
            fclose(result);
        }

        // try to shorten the URL (#40)
        /* assert(system("echo about:blank > ../fs/mnt/tabs/last-focused/url.txt") == 0); */
        /* assert(file_contents_equal("../fs/mnt/tabs/last-focused/url.txt", "about:blank")); */

        assert(system("echo remove > ../fs/mnt/tabs/last-focused/control") == 0);
    }

    {
        assert(system("echo file://$(pwd)/test-textarea.html > ../fs/mnt/tabs/create") == 0);
        {
            assert(system("echo \"document.getElementById('ta').value\" > ../fs/mnt/tabs/last-focused/evals/ta.js") == 0);

            FILE* result = fopen("../fs/mnt/tabs/last-focused/evals/ta.js.result", "r");
            char ta[100] = {0}; fread(ta, 1, sizeof(ta), result);
            fclose(result);

            assert(strcmp(ta, "\"initial text\"\n") == 0);

            // FIXME: check against the inputs file ...
            /* assert(file_contents_equal("../fs/mnt/tabs/last-focused/inputs/ta.txt", ta)); */

        }
        assert(system("echo remove > ../fs/mnt/tabs/last-focused/control") == 0);
    }

    assert(1); printf("Done!\n"); 
}
