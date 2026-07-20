# Third-party code

Court IQ vendors a single third-party library so the app can stay 100% offline
and dependency-free at runtime (no CDN, no `npm install` for end users).

## fflate

- File: `src/vendor/fflate.js`
- Purpose: synchronous, CSP-safe ZIP decompression (`.xlsx` files are ZIP archives).
- License: MIT
- Copyright (c) 2020 Arjun Barrett
- Homepage: https://github.com/101arrowz/fflate

Only the synchronous `unzipSync` path is used, so the library never spawns a
Web Worker or evaluates code — this keeps it compatible with strict Content
Security Policies.

Everything else in `src/` (the `xlsxlite` reader and all engine/UI code) is
original to this project and released under the repository's MIT license.
