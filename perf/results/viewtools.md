# View tools — frame times

Appended by e2e/perf/viewtools.perf.spec.ts. Read beside README.md's orbit table:
same machine, same fixtures, same render loop, one more thing turned on.

| parts | configuration | frames | median ms | p95 ms | max ms |
|---|---|---:|---:|---:|---:|
| 3200 | baseline | 970 | 3.80 | 6.70 | 21.60 |
| 3200 | cut-on hitch window | 14 | 7.00 | 296.20 | 296.20 |
| 3200 | cut on | 979 | 3.80 | 6.30 | 12.60 |
| 3200 | explode slider drag to 0.6 | 37 | 8.40 | 83.80 | 85.20 |
| 3200 | explode 0.6 | 1118 | 3.40 | 5.30 | 9.50 |
| 3200 | cut on + explode 0.6 | 1107 | 3.40 | 5.60 | 8.20 |
| 10000 | baseline | 594 | 6.60 | 10.70 | 27.30 |
| 10000 | cut-on hitch window | 4 | 40.30 | 114.50 | 114.50 |
| 10000 | cut on | 539 | 7.20 | 11.00 | 21.00 |
| 10000 | explode slider drag to 0.6 | 28 | 28.20 | 87.20 | 89.30 |
| 10000 | explode 0.6 | 605 | 6.50 | 9.70 | 24.60 |
| 10000 | cut on + explode 0.6 | 607 | 6.40 | 9.30 | 16.30 |
