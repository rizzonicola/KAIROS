# Stockfish source and NNUE lock

## Pin

- Upstream repository: `https://github.com/official-stockfish/Stockfish.git`
- Required release tag: `sf_19`
- Local checkout tag: `sf_19` (exact match)
- Exact commit: `edb0d9db6731067ec50ce619ff372b463bc4dd5d`
- Expected and present network filename: `nn-1a298aa575a0.nnue`
- `src/evaluate.h` defines `EvalFileDefaultName` as `nn-1a298aa575a0.nnue`.
- `src/Makefile` declares `help`, `net`, and `build`; `build` depends on `net` and `config-sanity`.
- Required configuration: native x86-64 executable, `Threads=1`, original network unchanged.

## Verified local build evidence

Commands and results from this workspace:

```text
$ git -C third_party/Stockfish describe --tags --exact-match
sf_19
$ git -C third_party/Stockfish rev-parse HEAD
edb0d9db6731067ec50ce619ff372b463bc4dd5d
$ git -C third_party/Stockfish status --porcelain --untracked-files=no
(no output: zero modified tracked files)
$ JOBS=16 bash scripts/build_stockfish19.sh
...
Built and identified Stockfish 19 successfully.
Engine: .../PROJECT/build/stockfish19
Engine SHA256: 75c1e915b0dd6768795f726230fb5d35e828c08e92c4a7d0584521d0bcbde89d
NNUE:   .../PROJECT/third_party/Stockfish/src/nn-1a298aa575a0.nnue
NNUE SHA256: 1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2
```

Engine transcript:

```text
$ printf 'uci\nquit\n' | ./build/stockfish19
id name Stockfish 19
option name EvalFile type string default nn-1a298aa575a0.nnue
uciok
```

Measured artifacts:

| Artifact | Value |
|---|---|
| NNUE filename | `nn-1a298aa575a0.nnue` |
| NNUE SHA-256 | `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2` |
| Engine binary SHA-256 | `75c1e915b0dd6768795f726230fb5d35e828c08e92c4a7d0584521d0bcbde89d` |
| Compiler | `g++ (GCC) 15.3.0` |
| Build target | `make -C third_party/Stockfish/src -j16 build ARCH=x86-64` |

The binary hash is build-dependent (compiler, flags, link layout). The NNUE hash is the content hash of the network file used by this build and is pinned in `scripts/build_stockfish19.sh`. This report does not claim an independently published upstream checksum; the measured value is the record for this workspace.

## Integrity enforcement

`scripts/build_stockfish19.sh` refuses to continue when:

1. The checkout is not an exact `sf_19` tag.
2. `HEAD` is not `edb0d9db6731067ec50ce619ff372b463bc4dd5d`.
3. Any tracked Stockfish source file is modified.
4. The expected NNUE file is missing.
5. The NNUE SHA-256 differs from the pinned value.
6. The built executable does not report `id name Stockfish 19`.
7. The executable does not declare `EvalFile` default `nn-1a298aa575a0.nnue`.

The script writes `build/stockfish19-build.txt` and `build/stockfish19-nnue.sha256`.

External references:

- Exact Git tag reference: <https://api.github.com/repos/official-stockfish/Stockfish/git/ref/tags/sf_19>.
- Pinned default network in upstream source: <https://github.com/official-stockfish/Stockfish/blob/sf_19/src/evaluate.h>.
- Pinned upstream Makefile: <https://github.com/official-stockfish/Stockfish/blob/sf_19/src/Makefile>.
- Stockfish compile instructions: <https://official-stockfish.github.io/docs/stockfish-wiki/Compiling-from-source.html>.
