import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('WASM block exporter supports the complete adaptive block candidate matrix', () => {
  const source = readFileSync(join(ROOT, 'Back end', 'tools', 'export_pocket_wasm_block_core.py'), 'utf8');
  assert.match(source, /add_argument\("--frames"/);
  assert.match(source, /choices=\(2, 4, 6, 8\)/);
  assert.match(source, /flow_lm_decode_block\{frames\}/);
  assert.match(source, /"decode_block_frames": frames/);
});

test('unified WASM core merger hoists shared branch weights into one session', () => {
  const source = readFileSync(join(ROOT, 'Back end', 'tools', 'merge_pocket_wasm_unified_core.py'), 'utf8');
  assert.match(source, /helper\.make_node\(\s*"If"/);
  assert.match(source, /dedupe_initializers/);
  assert.match(source, /prefill_empty_sequence/);
  assert.match(source, /flow_lm_unified_block4_int8\.onnx/);
  assert.match(source, /onnx\.checker\.check_model/);
});

test('device simulation never advertises WebGPU for iOS browsers', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'tools', 'pocket_device_simulation.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const rows = JSON.parse(output.slice(output.indexOf('[\n')));
  for (const row of rows.filter((candidate) => candidate.platform === 'ios')) {
    assert.equal(row.webgpu, 'unsupported');
    assert.equal(row.rtfWebgpu, null);
  }
});
