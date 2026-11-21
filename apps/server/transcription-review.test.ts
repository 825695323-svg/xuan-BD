import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranscriptionReviewEvidence } from './transcription-review.js';
const recognition = () => ({ backend: 'whisper.cpp-local', modelSha256: 'a'.repeat(64), durationMs: 11000 });
const probe = () => ({ format: { duration: '11.000000' }, streams: [{ codec_type: 'audio' }] });
const native = () => ({ transcription: [{ text: ' synthetic words', offsets: { from: 0, to: 5000 } }, { text: ' last words', offsets: { from: 5000, to: 11000 } }] });
const sourceSha256 = 'b'.repeat(64);
const envelope = (probeOutput: string) => ({ schema: 'bd-local-transcription-probe/1', sourceSha256, modelSha256: recognition().modelSha256, probeOutput });
const text = 'synthetic words\nlast words\n';
const parse = (r: unknown = recognition(), p: unknown = probe(), n: unknown = native(), t = text) => parseTranscriptionReviewEvidence(r, JSON.stringify(envelope(JSON.stringify(p))), JSON.stringify(n), t, sourceSha256);
test('transcription review uses original probe duration and actual model digest, retaining native intervals', () => {
  const result = parse(); assert.deepEqual(result.recognizer, recognition());
  assert.equal(result.segments[0]!.text, ' synthetic words');
  assert.deepEqual(result.segments[1]!.location, { startMs: 5000, endMs: 11000, cueIndex: 2 });
  const shortened = native(); shortened.transcription[1]!.offsets.to = 9000;
  assert.equal(parse(recognition(), probe(), shortened).recognizer.durationMs, 11000, 'Do not derive source duration from the final recognized segment.');
});
test('transcription review refuses missing, forged or unsupported execution metadata', () => {
  for (const value of [null, {}, { ...recognition(), backend: 'remote' }, { ...recognition(), modelSha256: 'unverified' },
    { ...recognition(), modelPath: '/some/model' }, { ...recognition(), durationMs: 11001 }, { ...recognition(), durationMs: 0 },
    { ...recognition(), durationMs: NaN }, { ...recognition(), durationMs: 11000.5 }]) assert.throws(() => parse(value));
  for (const value of [{}, { ...probe(), streams: [] }, { ...probe(), streams: [{ codec_type: 'video' }] },
    { ...probe(), format: {} }, { ...probe(), format: { duration: null } }, { ...probe(), format: { duration: 'Infinity' } },
    { ...probe(), format: { duration: '10.9' } }, { ...probe(), format: { duration: '3601' } }]) assert.throws(() => parse(recognition(), value));
});
test('transcription review refuses mismatched text, out-of-range or unordered native intervals', () => {
  assert.throws(() => parse(recognition(), probe(), native(), text + 'not spoken'));
  const mutations = [
    (v: any) => { delete v.transcription[0].offsets; },
    (v: any) => { v.transcription[0].offsets.from = -1; },
    (v: any) => { v.transcription[1].offsets.from = 4999; },
    (v: any) => { v.transcription[1].offsets.to = 12001; },
    (v: any) => { v.transcription[0].text = 'different'; },
  ];
  for (const mutate of mutations) { const value = native(); mutate(value); assert.throws(() => parse(recognition(), probe(), value)); }
  const tolerated = native(); tolerated.transcription[1]!.offsets.to = 12000;
  assert.equal(parse(recognition(), probe(), tolerated).segments[1]!.location.endMs, 12000, 'Preserve and disclose existing 1000ms tolerance, not new inferred duration.');
  assert.throws(() => parseTranscriptionReviewEvidence(recognition(), '{', JSON.stringify(native()), text, sourceSha256));
  assert.throws(() => parseTranscriptionReviewEvidence(recognition(), JSON.stringify(envelope(JSON.stringify(probe()))), '{', text, sourceSha256));
});

test('transcription execution envelope independently binds source and model, refusing old unbound probe output', () => {
  for (const value of [probe(), { ...envelope(JSON.stringify(probe())), sourceSha256: 'c'.repeat(64) },
    { ...envelope(JSON.stringify(probe())), modelSha256: 'c'.repeat(64) },
    { ...envelope(JSON.stringify(probe())), schema: 'legacy' },
    { ...envelope(JSON.stringify(probe())), probeOutput: '{}' }]) {
    assert.throws(() => parseTranscriptionReviewEvidence(recognition(), JSON.stringify(value), JSON.stringify(native()), text, sourceSha256));
  }
  assert.throws(() => parse({ ...recognition(), modelSha256: 'c'.repeat(64) }));
  assert.throws(() => parseTranscriptionReviewEvidence(undefined, JSON.stringify(envelope(JSON.stringify(probe()))), JSON.stringify(native()), text, sourceSha256));
});

test('video reviews require the actual selected audio stream and the container-relative extraction clock', () => {
  const raw = { format: { duration: '11.000', start_time: '2.000', format_name: 'matroska,webm' }, streams: [
    { codec_type: 'video', index: 0, width: 64, height: 64 },
    { codec_type: 'audio', index: 1, codec_name: 'opus', start_time: '3.000' },
    { codec_type: 'audio', index: 2, codec_name: 'opus', start_time: '2.000' }] };
  const replay = (p: unknown, schema = 'bd-local-transcription-probe/2') => parseTranscriptionReviewEvidence(recognition(),
    JSON.stringify({ ...envelope(JSON.stringify(p)), schema }), JSON.stringify(native()), text, sourceSha256);
  assert.deepEqual(replay(raw).media, { container: 'matroska,webm', audioCodec: 'opus',
    audioStreamIndex: 1, audioStartMs: 1000, timeline: 'container_relative_wav' });
  assert.throws(() => replay(raw, 'bd-local-transcription-probe/1'));
  assert.throws(() => replay({ ...raw, streams: raw.streams.slice(0, 1) }));
  assert.throws(() => replay({ ...raw, streams: [raw.streams[0], { ...raw.streams[1], start_time: 'unknown' }, raw.streams[2]] }));
  assert.throws(() => replay({ ...raw, format: { ...raw.format, duration: '10' } }));
});
