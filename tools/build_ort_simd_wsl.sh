#!/usr/bin/env bash
set -euo pipefail

ORT_TAG="${ORT_TAG:-v1.27.0}"
JOBS="${JOBS:-14}"
BUILD_ROOT="${BUILD_ROOT:-/opt/pocket-ort-simd}"
SOURCE_DIR="${BUILD_ROOT}/onnxruntime"
WINDOWS_OUTPUT="${WINDOWS_OUTPUT:-/mnt/c/Users/Chris/Documents/Web Build Antigravity Branch/ort-simd-build/onnxruntime/1.27.0-simd-minimal}"
LOG_DIR="${WINDOWS_OUTPUT}/build-evidence"
STOCK_ORT_DIST="${STOCK_ORT_DIST:-/mnt/c/Users/Chris/Documents/Web Build Antigravity Branch/pocket-webgpu-build/npm/package/dist}"

mkdir -p "${BUILD_ROOT}" "${WINDOWS_OUTPUT}" "${LOG_DIR}"
exec > >(tee -a "${LOG_DIR}/build.log") 2>&1

echo "Build started: $(date --iso-8601=seconds)"
echo "Variant: fixed-width SIMD + threads (no relaxed SIMD)"
echo "ORT tag: ${ORT_TAG}"
echo "Parallel jobs: ${JOBS}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential ca-certificates cmake curl git ninja-build nodejs npm \
  python3 python3-pip python3-venv wabt

if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  git clone \
    --branch "${ORT_TAG}" \
    --depth 1 \
    --recurse-submodules \
    --shallow-submodules \
    https://github.com/microsoft/onnxruntime.git \
    "${SOURCE_DIR}"
else
  echo "Reusing existing source checkout at ${SOURCE_DIR}"
fi

cd "${SOURCE_DIR}"
git rev-parse HEAD | tee "${LOG_DIR}/onnxruntime-commit.txt"
git status --short --branch | tee "${LOG_DIR}/onnxruntime-status.txt"

python3 tools/ci_build/build.py --help > "${LOG_DIR}/build-help.txt"

if [[ "${SKIP_COMPILE:-0}" != "1" ]]; then
  ./build.sh \
    --config Release \
    --build_wasm \
    --enable_wasm_simd \
    --enable_wasm_threads \
    --skip_tests \
    --disable_wasm_exception_catching \
    --disable_rtti \
    --allow_running_as_root \
    --parallel "${JOBS}"
else
  echo "Reusing the completed compile because SKIP_COMPILE=1."
fi

mapfile -t wasm_candidates < <(find build -type f -name 'ort-wasm-simd-threaded.wasm' -print)
mapfile -t mjs_candidates < <(find build -type f -name 'ort-wasm-simd-threaded.mjs' -print)

if [[ "${#wasm_candidates[@]}" -ne 1 || "${#mjs_candidates[@]}" -ne 1 ]]; then
  echo "Expected exactly one threaded SIMD WASM/MJS pair." >&2
  printf 'WASM candidates:\n%s\n' "${wasm_candidates[*]:-none}" >&2
  printf 'MJS candidates:\n%s\n' "${mjs_candidates[*]:-none}" >&2
  exit 3
fi

install -m 0644 "${wasm_candidates[0]}" "${WINDOWS_OUTPUT}/ort-wasm-simd-threaded.wasm"
install -m 0644 "${mjs_candidates[0]}" "${WINDOWS_OUTPUT}/ort-wasm-simd-threaded.mjs"
# The custom build is non-JSEP, so pair it with ORT's WASM-only public API
# module. It is intentionally published as ort.min.mjs inside the isolated
# runtime directory because Pocket imports that stable filename.
install -m 0644 "${STOCK_ORT_DIST}/ort.wasm.min.mjs" "${WINDOWS_OUTPUT}/ort.min.mjs"

wasm-objdump -d "${WINDOWS_OUTPUT}/ort-wasm-simd-threaded.wasm"   > "${LOG_DIR}/ort-wasm-simd-threaded.disassembly.txt"

# The entire point of this build is to run where relaxed SIMD does NOT validate.
# A binary containing relaxed opcodes would fail to instantiate on exactly the
# devices it was built for, so refuse to publish one.
if grep -Eiq 'relaxed[_ .-]*(dot|madd|nmadd|swizzle|laneselect|min|max|trunc|q15mulr)'   "${LOG_DIR}/ort-wasm-simd-threaded.disassembly.txt"; then
  echo present > "${LOG_DIR}/relaxed-opcode-status.txt"
  echo "Relaxed SIMD opcodes found in a build that must not contain them; refusing to certify." >&2
  exit 4
fi
echo absent > "${LOG_DIR}/relaxed-opcode-status.txt"

# And it must actually contain fixed-width SIMD, or it is just the stock build.
if ! grep -Eiq 'i32x4\.|f32x4\.|v128\.' "${LOG_DIR}/ort-wasm-simd-threaded.disassembly.txt"; then
  echo "No fixed-width SIMD instructions emitted; this build would be pointless." >&2
  exit 5
fi

(
  cd "${WINDOWS_OUTPUT}"
  sha256sum ort.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm \
    > build-evidence/sha256sums.txt
  wc -c ort.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm \
    > build-evidence/sizes.txt
)

echo "Build completed: $(date --iso-8601=seconds)"
