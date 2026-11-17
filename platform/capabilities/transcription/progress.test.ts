import assert from 'node:assert/strict';
import test from 'node:test';
import { createWhisperProgressParser } from './progress.js';
const line = (n: number) => `whisper_print_progress_callback: progress = ${String(n).padStart(3, ' ')}%`;
const bytes = (s: string) => Buffer.from(s);

test('only complete stderr callback lines emit strictly increasing native integers', () => {
  const parser = createWhisperProgressParser();
  assert.deepEqual(parser.push('stdout', bytes(line(100) + '\n')), []);
  assert.deepEqual(parser.push('stderr', bytes(line(1))), []);
  assert.deepEqual(parser.push('stderr', bytes('\n' + line(10) + '\r\n' + line(10) + '\n' + line(2) + '\n')), [1, 10]);
  assert.deepEqual(parser.push('stderr', bytes(line(99) + '\n' + line(100) + '\n' + line(100) + '\n')), [99, 100]);
});

test('all chunk boundaries including CRLF preserve exactly one observation and stdout cannot finish stderr', () => {
  const text = line(42) + '\r\n';
  for (let split = 0; split <= text.length; split++) {
    const parser = createWhisperProgressParser();
    const result = parser.push('stderr', bytes(text.slice(0, split)));
    assert.deepEqual(parser.push('stdout', bytes('\n' + line(100) + '\n')), []);
    result.push(...parser.push('stderr', bytes(text.slice(split))));
    assert.deepEqual(result, [42]);
  }
  const parser = createWhisperProgressParser();
  assert.deepEqual([...bytes(text)].flatMap(byte => parser.push('stderr', Buffer.from([byte]))), [42]);
});

test('out of range, noncanonical spacing, log text, prefixes, suffixes and non-ASCII bytes never emit', () => {
  const invalid = [line(0), line(-1), line(101), line(1000), line(12).replace(' 12%', '12%'),
    line(12).replace(' 12%', '012%'), line(12).replace(' 12%', '12.0%'), 'heartbeat',
    'prefix ' + line(12), line(12) + ' suffix', '\x1b[0m' + line(12), line(12) + '\rtrailing',
    '\r' + line(12), line(12) + '\r\r', line(12).replace(' 12%', '\t12%')];
  const parser = createWhisperProgressParser();
  for (const text of invalid) assert.deepEqual(parser.push('stderr', bytes(text + '\n')), [], text);
  const nonAscii = Buffer.from(line(12) + '\n'); nonAscii[0] = nonAscii[0]! | 128;
  assert.deepEqual(parser.push('stderr', nonAscii), []);
  assert.deepEqual(parser.push('stderr', bytes(line(12) + '\n')), [12]);
});

test('oversized lines discard every suffix until newline, with bounded state across chunks', () => {
  const parser = createWhisperProgressParser();
  assert.deepEqual(parser.push('stderr', bytes('x'.repeat(129))), []);
  assert.deepEqual(parser.push('stderr', bytes(line(90))), []);
  assert.deepEqual(parser.push('stderr', bytes('\r\n' + line(10) + '\n')), [10]);
  assert.deepEqual(parser.push('stderr', bytes('x'.repeat(1_000_000) + line(99) + '\n' + line(20) + '\n')), [20]);
  assert.deepEqual(parser.push('stderr', bytes(line(100))), []); // No EOF flush: incomplete lines never count.
});
