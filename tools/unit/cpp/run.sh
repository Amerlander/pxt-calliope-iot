#!/bin/sh
# Host tests for the C++ AT engine. Needs g++ (Linux, WSL or macOS with g++).
#   sh tools/unit/cpp/run.sh
# The engine is compiled as C++11 (what the DAL/CODAL toolchains use), the
# tests as C++17. AddressSanitizer + UBSan catch buffer and ring mistakes.
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/iot-wlanat-test"
mkdir -p "$OUT"
SAN="-fsanitize=address,undefined -fno-omit-frame-pointer"
# ENGINE_SRC lets a mutation run test a modified copy of the engine.
g++ -std=c++11 -Wall -Wextra -Wpedantic -Werror -O1 -g $SAN -I../../.. -c "${ENGINE_SRC:-../../../wlanat.cpp}" -o "$OUT/wlanat.o"
g++ -std=c++17 -Wall -Wextra -O1 -g $SAN test_wlanat.cpp "$OUT/wlanat.o" -o "$OUT/test_wlanat"
"$OUT/test_wlanat"
