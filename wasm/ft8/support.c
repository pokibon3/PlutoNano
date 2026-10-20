// Minimal libc / libm for the freestanding wasm32 build of ft8_lib (no Emscripten, no WASI).
// The heap is a bump allocator: ft8_lib allocates once in monitor_init and never frees in normal use.
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>

extern unsigned char __heap_base;
static uintptr_t heap_top = 0;

void *malloc(size_t n) {
  if (!heap_top) heap_top = (uintptr_t)&__heap_base;
  uintptr_t p = (heap_top + 15) & ~(uintptr_t)15;
  uintptr_t end = p + n;
  uintptr_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (end > have && __builtin_wasm_memory_grow(0, (end - have + 65535) / 65536) == (size_t)-1) return 0;
  heap_top = end;
  return (void *)p;
}
void free(void *p) { (void)p; }
void *memset(void *d, int c, size_t n) { unsigned char *q = d; while (n--) *q++ = (unsigned char)c; return d; }
void *calloc(size_t n, size_t m) { void *p = malloc(n * m); if (p) memset(p, 0, n * m); return p; }
void *memcpy(void *d, const void *s, size_t n) { unsigned char *q = d; const unsigned char *r = s; while (n--) *q++ = *r++; return d; }
void *memmove(void *d, const void *s, size_t n) {
  unsigned char *q = d; const unsigned char *r = s;
  if (q < r) while (n--) *q++ = *r++; else { q += n; r += n; while (n--) *--q = *--r; }
  return d;
}
void *realloc(void *p, size_t n) { void *q = malloc(n); if (q && p) memcpy(q, p, n); return q; }
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *p = a, *q = b;
  for (; n--; p++, q++) if (*p != *q) return *p - *q;
  return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)); return r; }
char *strncpy(char *d, const char *s, size_t n) { size_t i = 0; for (; i < n && s[i]; i++) d[i] = s[i]; for (; i < n; i++) d[i] = 0; return d; }
char *strcat(char *d, const char *s) { strcpy(d + strlen(d), s); return d; }
char *stpcpy(char *d, const char *s) { while ((*d = *s++)) d++; return d; }
char *strchr(const char *s, int c) { for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return (unsigned char)*a - (unsigned char)*b; }
int strncmp(const char *a, const char *b, size_t n) { for (; n && *a && *a == *b; n--) a++, b++; return n ? (unsigned char)*a - (unsigned char)*b : 0; }
int atoi(const char *s) { int v = 0, neg = 0; while (*s == ' ') s++; if (*s == '-' || *s == '+') neg = *s++ == '-'; while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0'); return neg ? -v : v; }
int abs(int x) { return x < 0 ? -x : x; }
typedef struct FILE FILE;
int printf(const char *f, ...) { (void)f; return 0; }
int fprintf(FILE *fp, const char *f, ...) { (void)fp; (void)f; return 0; }

// snprintf: only %d / %s / %c / %% are needed by ft8_lib's message unpacking
static int put(char *b, size_t n, size_t *k, char c) { if (*k + 1 < n) b[*k] = c; (*k)++; return 0; }
int vsnprintf(char *b, size_t n, const char *f, va_list ap) {
  size_t k = 0;
  for (; *f; f++) {
    if (*f != '%') { put(b, n, &k, *f); continue; }
    f++;
    int width = 0, zero = 0;
    if (*f == '0') { zero = 1; f++; }
    while (*f >= '0' && *f <= '9') width = width * 10 + (*f++ - '0');
    if (*f == 'd' || *f == 'u') {
      long v = *f == 'd' ? va_arg(ap, int) : va_arg(ap, unsigned);
      char t[24]; int m = 0, neg = v < 0; unsigned long u = neg ? -v : v;
      do t[m++] = '0' + u % 10; while (u /= 10);
      if (neg) t[m++] = '-';
      while (m < width) t[m++] = zero ? '0' : ' ';
      while (m) put(b, n, &k, t[--m]);
    } else if (*f == 's') { const char *s = va_arg(ap, const char *); while (*s) put(b, n, &k, *s++); }
    else if (*f == 'c') put(b, n, &k, (char)va_arg(ap, int));
    else put(b, n, &k, *f);
  }
  if (n) b[k < n ? k : n - 1] = 0;
  return (int)k;
}
int snprintf(char *b, size_t n, const char *f, ...) { va_list ap; va_start(ap, f); int r = vsnprintf(b, n, f, ap); va_end(ap); return r; }
int sprintf(char *b, const char *f, ...) { va_list ap; va_start(ap, f); int r = vsnprintf(b, 1u << 20, f, ap); va_end(ap); return r; }

// --- libm (double precision; accurate to ~1e-15 for the ranges ft8_lib uses) ---
static const double PI = 3.14159265358979323846, LN2 = 0.69314718055994530942;
static double sin_k(double x) { double x2 = x * x; return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156 * (1 - x2 / 210))))))); }
static double cos_k(double x) { double x2 = x * x; return 1 - x2 / 2 * (1 - x2 / 12 * (1 - x2 / 30 * (1 - x2 / 56 * (1 - x2 / 90 * (1 - x2 / 132 * (1 - x2 / 182 * (1 - x2 / 240))))))); }
double sin(double x) {
  double q = __builtin_floor(x / (PI / 2) + 0.5); double r = x - q * (PI / 2); long k = (long)q & 3;
  return k == 0 ? sin_k(r) : k == 1 ? cos_k(r) : k == 2 ? -sin_k(r) : -cos_k(r);
}
double cos(double x) { return sin(x + PI / 2); }
double exp(double x) {
  double k = __builtin_floor(x / LN2 + 0.5), r = x - k * LN2, s = 1, t = 1;
  for (int i = 1; i < 20; i++) { t *= r / i; s += t; }
  long e = (long)k; union { double d; uint64_t u; } v = { s };
  v.u += (uint64_t)e << 52;
  return v.d;
}
double log(double x) {
  if (x <= 0) return -1e300;
  union { double d; uint64_t u; } v = { x };
  long e = (long)((v.u >> 52) & 0x7ff) - 1023;
  v.u = (v.u & 0x000fffffffffffffull) | 0x3ff0000000000000ull; // mantissa in [1, 2)
  double m = v.d; if (m > 1.41421356237) { m /= 2; e++; }
  double z = (m - 1) / (m + 1), z2 = z * z, s = 0, t = z;
  for (int i = 1; i < 40; i += 2) { s += t / i; t *= z2; }
  return 2 * s + e * LN2;
}
float sinf(float x) { return (float)sin(x); }
float cosf(float x) { return (float)cos(x); }
float expf(float x) { return (float)exp(x); }
float logf(float x) { return (float)log(x); }
float log10f(float x) { return (float)(log(x) / 2.30258509299404568402); }
float powf(float x, float y) { return x <= 0 ? 0 : (float)exp(y * log(x)); }
float atan2f(float y, float x) {
  double ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, a;
  if (ax == 0 && ay == 0) return 0;
  double t = ax > ay ? ay / ax : ax / ay, s = 0, p = t;
  // atan(t) for t in [0,1] via atan(t) = 2 atan(t / (1 + sqrt(1 + t^2)))
  double u = t / (1 + __builtin_sqrt(1 + t * t)), u2 = u * u; p = u;
  for (int i = 1; i < 60; i += 2) { s += (i & 2 ? -p : p) / i; p *= u2; }
  a = 2 * s;
  if (ay > ax) a = PI / 2 - a;
  if (x < 0) a = PI - a;
  return (float)(y < 0 ? -a : a);
}
void exit(int code) { (void)code; __builtin_trap(); }
double fmod(double x, double y) { return x - y * __builtin_trunc(x / y); }
