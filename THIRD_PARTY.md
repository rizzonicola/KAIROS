# Third-party components

KAIROS is licensed under GPL-3.0. The release artifacts include or depend on the
following components. This file records provenance; it is not a substitute for
the licenses themselves.

## Stockfish 19

- Upstream: <https://github.com/official-stockfish/Stockfish>
- Tag: `sf_19`
- Commit: `edb0d9db6731067ec50ce619ff372b463bc4dd5d`
- License: GNU General Public License v3.0 (`LICENSE`)
- Network: `nn-1a298aa575a0.nnue`
- Network SHA-256: `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`

The native KAIROS build uses the official Stockfish source at this exact tag and
the original network. KAIROS does not modify Stockfish source, search code, or
the network; it runs Stockfish as a child UCI process.

## Stockfish.js (optional Lite WebAssembly builds)

- Upstream: <https://github.com/nmrugg/stockfish.js>
- Tag: `v19.0.1`
- Commit: `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`
- License: GPL-3.0 for the engine; MIT for the non-engine glue. The distributed
  engine artifacts are GPL-3.0 because they contain Stockfish.
- Lite network: `nn-61e7af4bb97d.nnue`, downloaded by the upstream build script
  from the Stockfish Fishtest network server.

Stockfish.js is used only for the optional `lite` and `lite-single` WebAssembly
artifacts. Those artifacts use a smaller network, so they are not the pinned
native KAIROS engine and must not be presented as the validated Stockfish 19
network build. They are provided for browsers and Node.js where download size
and the absence of `SharedArrayBuffer` matter.

## Emscripten

- Upstream: <https://github.com/emscripten-core/emscripten>
- Used to compile the WebAssembly artifacts.
- License: MIT / University of Illinois Open Source License.

## Node.js

- Upstream: <https://nodejs.org/>
- Used to run and smoke-test the WebAssembly artifacts. Node.js is not
  distributed in the release archives.

## Python

- Upstream: <https://www.python.org/>
- License: Python Software Foundation License.
- KAIROS uses only the Python standard library.

## References

- Stockfish compiling guide:
  <https://official-stockfish.github.io/docs/stockfish-wiki/Compiling-from-source.html>
- Stockfish Fishtest networks:
  <https://tests.stockfishchess.org/nns>
- GPL-3.0:
  <https://www.gnu.org/licenses/gpl-3.0.html>
