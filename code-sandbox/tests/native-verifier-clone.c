#define _GNU_SOURCE
/* Owned container fixture only: a non-SIGCHLD clone child escapes the session,
 * survives its direct parent, and holds output open until the verifier drains it.
 * Never executed on a host; no UID selection, namespace changes or capabilities. */
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
struct ready { int read_fd; int write_fd; };
static int escaped(void *raw) {
    struct ready *fds = raw;
    close(fds->read_fd);
    if (setsid() < 0) _exit(20);
    if (signal(SIGTERM, SIG_IGN) == SIG_ERR) _exit(21);
    if (write(fds->write_fd, "r", 1) != 1) _exit(22);
    close(fds->write_fd);
    for (;;) pause();
    return 0;
}
int main(void) {
    const char *enabled = getenv("NOEVIA_NATIVE_VERIFIER_FIXTURE");
    if (getuid() != 1003 || getgid() != 1003 || enabled == NULL || strcmp(enabled, "1") != 0) return 2;
    int fds[2];
    if (pipe(fds) < 0) return 10;
    struct ready ready = {fds[0], fds[1]};
    const size_t size = 1024 * 1024;
    char *stack = malloc(size);
    if (stack == NULL) return 11;
    /* Low signal bits are zero, deliberately not SIGCHLD. */
    if (clone(escaped, stack + size, 0, &ready) < 0) return 12;
    close(fds[1]);
    char value = 0;
    if (read(fds[0], &value, 1) != 1 || value != 'r') return 13;
    close(fds[0]);
    puts("NON_SIGCHLD_CLONE_READY");
    free(stack);
    return 0;
}
