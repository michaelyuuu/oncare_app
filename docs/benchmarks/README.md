# Visit benchmark

`npm run bench:visit` exercises the local API with the synthetic family, resident-device, staff, and mock-gateway accounts. Set `API` to another local API URL and `N` to change the number of iterations; defaults are `http://127.0.0.1:3000` and 20 runs.

The script opens the device event stream, measures the request-to-`awaiting_resident_consent` notification latency, completes the simulated visit, and exports the staff-only `/benchmark.csv` response. It prints the notification median/p95, completion success rate, and target verdict. The target is notification median under 3 seconds and at least 95% successful completions.

The API and mock gateway must already be running. This repository does not contain a committed baseline CSV or summary: run the benchmark against a real local stack before recording measurements, and keep generated files out of commits unless they are genuine dated evidence. Physical Jetson rehearsals are separate and are not represented by this script.
