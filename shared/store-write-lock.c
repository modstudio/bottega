#include <errno.h>
#include <fcntl.h>

int orch_fcntl_getlk(int fd, struct flock *lock) {
  if (fcntl(fd, F_GETLK, lock) == -1) return errno;
  return 0;
}
