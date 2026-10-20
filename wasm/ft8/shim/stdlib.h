#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t m);
void *realloc(void *p, size_t n);
void free(void *p);
int atoi(const char *s);
int abs(int x);
void exit(int code);
