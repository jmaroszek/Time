// Verifies an update manifest the way a client will, before anyone uploads it.
//
// The update signature has one failure mode and it is silent: anything that
// rewrites the installer after the signature was computed — Authenticode, a
// repack, a rebuild that was not re-signed, a manifest copied from an earlier
// run — leaves a manifest that parses, downloads, and then fails verification
// on every user's machine. Nothing upstream of the user notices. A build whose
// baked-in `pubkey` is not the half of the keypair that signed fails the same
// way, and that is the easiest mistake to make while setting the keypair up.
//
// This runs exactly the client's computation — the signature string as it
// appears in latest.json, over the installer's bytes, against the public key as
// it appears in tauri.conf.json — so a pass here means the only remaining
// variables are the network and the upload.
//
// Dependency-free on purpose: it has to be runnable at the moment of doubt,
// including from a checkout with nothing installed.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = join(REPOSITORY, "dashboard", "src-tauri", "tauri.conf.json");
const PLACEHOLDER = "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY";

/** Tauri looks its own platform up by this exact key, and a client that does
 *  not find it reports "no update" rather than an error. */
const TARGET = "windows-x86_64";

/** SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key. Node only accepts
 *  a structured key; minisign stores a bare one. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

class VerificationError extends Error {}

/** minisign's container: a comment line, a base64 payload, and for signatures a
 *  second comment/payload pair. Tauri wraps the whole file in another base64
 *  layer before it reaches a config field or a manifest. */
function readMinisignFile(text, { expectTrustedComment }) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const payloads = lines.filter(
    (line) => !line.startsWith("untrusted comment:") && !line.startsWith("trusted comment:"),
  );
  if (payloads.length < (expectTrustedComment ? 2 : 1)) {
    throw new VerificationError("malformed minisign data: too few payload lines");
  }
  const trusted = lines.find((line) => line.startsWith("trusted comment:"));
  if (expectTrustedComment && trusted === undefined) {
    throw new VerificationError("malformed signature: no trusted comment");
  }
  return {
    payload: Buffer.from(payloads[0], "base64"),
    globalSignature: expectTrustedComment ? Buffer.from(payloads[1], "base64") : null,
    // The signed bytes are everything after the prefix, which is part of the
    // line rather than a separator — an off-by-one here fails verification.
    trustedComment: trusted === undefined ? null : trusted.slice("trusted comment: ".length),
  };
}

function decodeOuterBase64(value, label) {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (!decoded.includes("comment:")) {
    throw new VerificationError(`${label} is not base64-wrapped minisign data`);
  }
  return decoded;
}

function parsePublicKey(configValue) {
  if (configValue === PLACEHOLDER) {
    throw new VerificationError(
      "tauri.conf.json still carries the updater public-key placeholder; there is nothing to verify against",
    );
  }
  const { payload } = readMinisignFile(decodeOuterBase64(configValue, "public key"), {
    expectTrustedComment: false,
  });
  if (payload.length !== 42) {
    throw new VerificationError(`public key payload is ${payload.length} bytes, expected 42`);
  }
  return { keyId: payload.subarray(2, 10), key: payload.subarray(10) };
}

function parseSignature(signatureValue) {
  const { payload, globalSignature, trustedComment } = readMinisignFile(
    decodeOuterBase64(signatureValue, "signature"),
    { expectTrustedComment: true },
  );
  if (payload.length !== 74) {
    throw new VerificationError(`signature payload is ${payload.length} bytes, expected 74`);
  }
  return {
    algorithm: payload.subarray(0, 2).toString("latin1"),
    keyId: payload.subarray(2, 10),
    signature: payload.subarray(10),
    globalSignature,
    trustedComment,
  };
}

function ed25519(key) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
    format: "der",
    type: "spki",
  });
}

/** Throws unless `signatureValue` is a valid minisign signature over `bytes`
 *  under `publicKeyValue`. Both values are in the base64-wrapped form Tauri
 *  puts in tauri.conf.json and in latest.json. */
export function verifyUpdateSignature(bytes, signatureValue, publicKeyValue) {
  const pub = parsePublicKey(publicKeyValue);
  const sig = parseSignature(signatureValue);

  if (!pub.keyId.equals(sig.keyId)) {
    throw new VerificationError(
      `signature was made by key ${sig.keyId.toString("hex")}, but the build trusts ` +
        `${pub.keyId.toString("hex")} — these are different keypairs`,
    );
  }

  // "ED" is minisign's prehashed mode, which is what `tauri signer` emits; "Ed"
  // signs the file directly. Accepting both costs three lines and means a future
  // CLI change cannot turn this check into a false alarm.
  let message;
  if (sig.algorithm === "ED") {
    message = createHash("blake2b512").update(bytes).digest();
  } else if (sig.algorithm === "Ed") {
    message = bytes;
  } else {
    throw new VerificationError(`unknown minisign algorithm '${sig.algorithm}'`);
  }

  if (!edVerify(null, message, ed25519(pub.key), sig.signature)) {
    throw new VerificationError(
      "signature does not match the file — its bytes changed after it was signed",
    );
  }

  // minisign signs its own trusted comment too. Skipping this would leave the
  // filename and timestamp recorded there unauthenticated.
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!edVerify(null, globalMessage, ed25519(pub.key), sig.globalSignature)) {
    throw new VerificationError("the signature's trusted comment is not itself signed correctly");
  }

  return {
    algorithm: sig.algorithm,
    keyId: pub.keyId.toString("hex"),
    trustedComment: sig.trustedComment,
  };
}

function parseArguments(argv) {
  const options = {
    installer: null,
    manifest: null,
    signature: null,
    pubkey: null,
    config: DEFAULT_CONFIG,
  };
  const flags = new Map([
    ["--manifest", "manifest"],
    ["--signature", "signature"],
    ["--pubkey", "pubkey"],
    ["--config", "config"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new VerificationError(`${argument} needs a value`);
      options[flags.get(argument)] = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new VerificationError(`unknown option '${argument}'`);
    } else if (options.installer === null) {
      options.installer = argument;
    } else {
      throw new VerificationError(`unexpected argument '${argument}'`);
    }
  }
  if (options.installer === null) {
    throw new VerificationError(
      "usage: node scripts/verify_update_signature.mjs <installer> [--manifest latest.json] " +
        "[--signature file.sig] [--pubkey <base64>] [--config tauri.conf.json]",
    );
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  const bytes = readFileSync(options.installer);

  const publicKeyValue =
    options.pubkey ?? JSON.parse(readFileSync(options.config, "utf8")).plugins.updater.pubkey;

  // The manifest is the preferred input because it is what clients actually
  // read. A .sig file sitting next to the installer can be perfectly correct
  // while the manifest that gets uploaded carries a stale copy of it.
  let signatureValue;
  let manifest = null;
  if (options.manifest !== null) {
    manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
    const platform = manifest.platforms?.[TARGET];
    if (platform === undefined) {
      throw new VerificationError(`manifest has no '${TARGET}' platform entry`);
    }
    signatureValue = platform.signature;
    const named = basename(new URL(platform.url).pathname);
    if (named !== basename(options.installer)) {
      throw new VerificationError(
        `manifest points at '${named}' but the file being verified is '${basename(options.installer)}'`,
      );
    }
  } else {
    signatureValue = readFileSync(options.signature ?? `${options.installer}.sig`, "utf8").trim();
  }

  const result = verifyUpdateSignature(bytes, signatureValue, publicKeyValue);

  console.log("Update signature verified.");
  console.log(`  File      : ${options.installer} (${bytes.length} bytes)`);
  console.log(`  Key id    : ${result.keyId}`);
  console.log(`  Algorithm : ${result.algorithm}`);
  console.log(`  Signed as : ${result.trustedComment}`);
  if (manifest !== null) {
    console.log(`  Version   : ${manifest.version}`);
    console.log(`  URL       : ${manifest.platforms[TARGET].url}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof VerificationError ? `Verification failed: ${error.message}` : error,
    );
    process.exit(1);
  }
}
