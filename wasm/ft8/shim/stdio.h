#pragma once
#include <stddef.h>
#include <stdarg.h>
typedef struct FILE FILE;
#define stderr ((FILE *)0)
#define stdout ((FILE *)0)
int printf(const char *f, ...);
int fprintf(FILE *fp, const char *f, ...);
int snprintf(char *b, size_t n, const char *f, ...);
int sprintf(char *b, const char *f, ...);
