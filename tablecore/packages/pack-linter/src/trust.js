import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyArtifactManifest, readDirectoryFileEntries } from './artifactDigest.js';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function canonicalPackDescriptor(descriptor) { return stable(descriptor); }

export function signPackDescriptor(descriptor, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  return crypto.sign(null, Buffer.from(canonicalPackDescriptor(descriptor)), key).toString('base64url');
}

export function verifyPackDescriptor(descriptor, signature, publicKey) {
  try {
    const key = crypto.createPublicKey(publicKey);
    return crypto.verify(null, Buffer.from(canonicalPackDescriptor(descriptor)), key, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

export function verifyTrustedPackDescriptor(descriptor, trustStore = {}, { files = null } = {}) {
  if (!descriptor || typeof descriptor !== 'object') return { ok:false, code:'INVALID_DESCRIPTOR' };
  if (descriptor.trust?.signature == null || descriptor.trust?.keyId == null) return { ok:false, code:'PACK_SIGNATURE_REQUIRED' };
  const entry = trustStore[descriptor.trust.keyId];
  if (!entry) return { ok:false, code:'UNKNOWN_TRUST_KEY' };
  const publicKey = typeof entry === 'string' ? entry : entry.publicKey;
  if (!publicKey) return { ok:false, code:'TRUST_KEY_MISCONFIGURED' };
  const declared = Array.isArray(descriptor.capabilities) ? descriptor.capabilities : [];
  const allowed = typeof entry === 'object' && Array.isArray(entry.capabilities) ? new Set(entry.capabilities) : null;
  if (allowed && declared.some(capability => !allowed.has(capability))) return { ok:false, code:'PACK_CAPABILITY_DENIED' };
  const clean = structuredClone(descriptor);
  delete clean.trust;
  if (!verifyPackDescriptor(clean, descriptor.trust.signature, publicKey)) return { ok:false, code:'INVALID_PACK_SIGNATURE' };

  // The signature above only ever proved the DESCRIPTOR (this metadata
  // object) was vouched for by a trusted key -- see artifactDigest.js's
  // module doc comment for why that is a materially weaker claim than
  // "these exact executable/content bytes were vouched for". When the
  // descriptor carries an `artifact` manifest (itself covered by the
  // same signature, since it is just another descriptor field), and the
  // caller actually supplies the real files to check, this closes that
  // gap. `artifactVerified` is deliberately explicit about which of
  // three states applies -- 'not-declared' (the descriptor never
  // committed to specific bytes at all), 'not-checked' (it did, but the
  // caller didn't supply files to verify against -- signature-only, same
  // as before this existed), or true/false (it did, and was actually
  // checked) -- so a caller can never mistake "I verified a signature"
  // for "I verified the bytes" by accident.
  let artifactVerified = 'not-declared';
  let artifactVerification = null;
  if (descriptor.artifact) {
    if (files == null) {
      artifactVerified = 'not-checked';
    } else {
      artifactVerification = verifyArtifactManifest(descriptor.artifact, files);
      artifactVerified = artifactVerification.ok;
      if (!artifactVerification.ok) return { ok:false, code:'ARTIFACT_MISMATCH', artifactVerified, artifactVerification };
    }
  }

  return { ok:true, keyId:descriptor.trust.keyId, capabilities:declared, artifactVerified, artifactVerification };
}

/**
 * Convenience for the real, common case: verify a signed descriptor
 * against the actual files sitting in a real directory on disk, in one
 * call. `descriptorPath`/`dirPath` are both real filesystem paths.
 */
export async function readAndVerifyTrustedPackWithArtifact(descriptorPath, dirPath, trustStore) {
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const files = await readDirectoryFileEntries(dirPath);
  return { descriptor, verification: verifyTrustedPackDescriptor(descriptor, trustStore, { files }) };
}

export async function readAndVerifyTrustedPack(path, trustStore) {
  const descriptor = JSON.parse(await readFile(path, 'utf8'));
  return { descriptor, verification: verifyTrustedPackDescriptor(descriptor, trustStore) };
}
