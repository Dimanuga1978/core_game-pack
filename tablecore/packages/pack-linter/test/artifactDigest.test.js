import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeArtifactManifest, verifyArtifactManifest, readDirectoryFileEntries,
  signPackDescriptor, verifyTrustedPackDescriptor, readAndVerifyTrustedPackWithArtifact,
} from '../src/index.js';

// P0-ARTIFACT (external remediation request): "the signature authenticates
// the manifest/descriptor, not the artifact... verify signature covers a
// content hash of the actual game code/content, not just metadata."
// These tests use REAL files on real disk -- not string literals standing
// in for file content -- because the whole point being tested is that
// this binds to actual bytes, not a description of bytes.

async function makeTempPackDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

test('computeArtifactManifest/verifyArtifactManifest: identical file sets verify, any byte change is caught', async () => {
  const files = [
    { path: 'server.js', content: "module.exports = { id: 'x' };\n" },
    { path: 'content/pack.json', content: '{"cards":[]}\n' },
  ];
  const manifest = computeArtifactManifest(files);
  assert.equal(manifest.algorithm, 'sha256');
  assert.equal(Object.keys(manifest.files).length, 2);

  assert.equal(verifyArtifactManifest(manifest, files).ok, true);

  const tampered = [
    { path: 'server.js', content: "module.exports = { id: 'x', BACKDOOR: true };\n" }, // one byte-level change
    { path: 'content/pack.json', content: '{"cards":[]}\n' },
  ];
  const result = verifyArtifactManifest(manifest, tampered);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARTIFACT_MISMATCH');
  assert.deepEqual(result.mismatches.map(m => m.path), ['server.js']);
});

test('verifyArtifactManifest detects added and removed files, not just changed ones', () => {
  const original = [{ path: 'a.js', content: '1' }, { path: 'b.js', content: '2' }];
  const manifest = computeArtifactManifest(original);

  const missing = [{ path: 'a.js', content: '1' }]; // b.js removed
  const missingResult = verifyArtifactManifest(manifest, missing);
  assert.equal(missingResult.ok, false);
  assert.deepEqual(missingResult.missingFiles, ['b.js']);

  const extra = [{ path: 'a.js', content: '1' }, { path: 'b.js', content: '2' }, { path: 'evil.js', content: 'x' }];
  const extraResult = verifyArtifactManifest(manifest, extra);
  assert.equal(extraResult.ok, false);
  assert.deepEqual(extraResult.extraFiles, ['evil.js']);
});

test('readDirectoryFileEntries reads REAL files from a REAL directory on disk with normalized relative paths', async () => {
  const dir = await makeTempPackDir({
    'server.js': "module.exports = {};\n",
    'content/pack.json': '{}\n',
  });
  try {
    const entries = await readDirectoryFileEntries(dir);
    const paths = entries.map(e => e.path).sort();
    assert.deepEqual(paths, ['content/pack.json', 'server.js']);
    const serverEntry = entries.find(e => e.path === 'server.js');
    assert.equal(serverEntry.content.toString('utf8'), "module.exports = {};\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('end-to-end: a descriptor with a real artifact manifest, signed, verifies against the real directory it describes -- and fails when the directory is tampered with after signing', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dir = await makeTempPackDir({
    'server.js': "module.exports = { id: 'artifact-test-pack' };\n",
    'content/pack.json': '{"cards":[]}\n',
  });
  try {
    const fileEntries = await readDirectoryFileEntries(dir);
    const artifact = computeArtifactManifest(fileEntries);
    const base = { manifest: { id: 'artifact-test-pack', version: '1.0.0' }, artifact };
    const signature = signPackDescriptor(base, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const descriptor = { ...base, trust: { keyId: 'k', signature } };
    const trustStore = { k: publicKey.export({ type: 'spki', format: 'pem' }) };

    // Signature-only check (no files supplied) must say so explicitly,
    // not silently claim the bytes were verified.
    const signatureOnly = verifyTrustedPackDescriptor(descriptor, trustStore);
    assert.equal(signatureOnly.ok, true);
    assert.equal(signatureOnly.artifactVerified, 'not-checked');

    // With the real files supplied, the artifact is actually checked.
    const withFiles = verifyTrustedPackDescriptor(descriptor, trustStore, { files: fileEntries });
    assert.equal(withFiles.ok, true);
    assert.equal(withFiles.artifactVerified, true);

    // Now tamper with a file ON DISK, after the descriptor was signed --
    // exactly the attack this whole mechanism exists to catch: the
    // signature over the descriptor is technically still "valid" (the
    // descriptor JSON itself, including its artifact manifest, wasn't
    // touched), but the actual bytes on disk no longer match what was
    // signed for.
    await writeFile(join(dir, 'server.js'), "module.exports = { id: 'artifact-test-pack', BACKDOOR: true };\n");
    const tamperedFiles = await readDirectoryFileEntries(dir);
    const afterTamper = verifyTrustedPackDescriptor(descriptor, trustStore, { files: tamperedFiles });
    assert.equal(afterTamper.ok, false);
    assert.equal(afterTamper.code, 'ARTIFACT_MISMATCH');
    assert.deepEqual(afterTamper.artifactVerification.mismatches.map(m => m.path), ['server.js']);

    // Convenience end-to-end helper does the same thing in one call.
    const descriptorPath = join(dir, '..', 'descriptor.json');
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const combined = await readAndVerifyTrustedPackWithArtifact(descriptorPath, dir, trustStore);
    assert.equal(combined.verification.ok, false);
    await rm(descriptorPath, { force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a descriptor with no artifact field at all is reported as not-declared, never confused with a passing check', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const base = { manifest: { id: 'no-artifact-pack', version: '1.0.0' } }; // no `artifact` key
  const signature = signPackDescriptor(base, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const descriptor = { ...base, trust: { keyId: 'k', signature } };
  const trustStore = { k: publicKey.export({ type: 'spki', format: 'pem' }) };
  const result = verifyTrustedPackDescriptor(descriptor, trustStore, { files: [{ path: 'anything.js', content: 'x' }] });
  assert.equal(result.ok, true);
  assert.equal(result.artifactVerified, 'not-declared', 'supplying files does not retroactively invent an artifact commitment the descriptor never made');
});
