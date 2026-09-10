// Prints "<pid> <responsible pid>" for every pid given, or for all processes
// with no arguments. The responsible pid is what Activity Monitor groups by.
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <unistd.h>
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t);
static void one(pid_t p) { printf("%d %d\n", p, responsibility_get_pid_responsible_for_pid(p)); }
int main(int argc, char **argv) {
  if (argc > 1) { for (int i = 1; i < argc; i++) one((pid_t)atoi(argv[i])); return 0; }
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  size_t len = 0;
  if (sysctl(mib, 4, NULL, &len, NULL, 0) != 0) return 1;
  struct kinfo_proc *procs = malloc(len);
  if (sysctl(mib, 4, procs, &len, NULL, 0) != 0) return 1;
  size_t n = len / sizeof(struct kinfo_proc);
  for (size_t i = 0; i < n; i++) one(procs[i].kp_proc.p_pid);
  free(procs);
  return 0;
}
