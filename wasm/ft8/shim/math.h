#pragma once
#define M_PI 3.14159265358979323846
#define fabsf(x) __builtin_fabsf(x)
#define fabs(x) __builtin_fabs(x)
#define sqrtf(x) __builtin_sqrtf(x)
#define sqrt(x) __builtin_sqrt(x)
#define floorf(x) __builtin_floorf(x)
#define floor(x) __builtin_floor(x)
#define roundf(x) __builtin_roundf(x)
#define fmaxf(a, b) __builtin_fmaxf(a, b)
#define fminf(a, b) __builtin_fminf(a, b)
double sin(double x);
double cos(double x);
double exp(double x);
double log(double x);
float sinf(float x);
float cosf(float x);
float expf(float x);
float logf(float x);
float log10f(float x);
float powf(float x, float y);
float atan2f(float y, float x);
double fmod(double x, double y);
