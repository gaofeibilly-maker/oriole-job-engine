import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { throwIfOperationAborted } from "./operation-context.mjs";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class FileArtifactStore {
  constructor(root) {
    if (!root) throw new TypeError("FileArtifactStore 需要目录");
    this.root = root;
  }

  async put(response, { kind = "http_response", sourceId = null, runId = null, page = null } = {}) {
    throwIfOperationAborted();
    const hash = response.contentHash;
    if (!/^[a-f0-9]{64}$/.test(String(hash || ""))) throw new TypeError("artifact 需要 SHA-256 contentHash");
    const rawBody = response.rawBody instanceof Uint8Array
      ? Buffer.from(response.rawBody.buffer, response.rawBody.byteOffset, response.rawBody.byteLength)
      : Buffer.from(response.body, "utf8");
    const actualHash = createHash("sha256").update(rawBody).digest("hex");
    if (actualHash !== hash) throw new TypeError("artifact 原始字节与 contentHash 不一致");
    const prefix = hash.slice(0, 2);
    const bodyPath = join(this.root, prefix, `${hash}.gz`);
    const blobMetadataPath = join(this.root, prefix, `${hash}.json`);
    await mkdir(dirname(bodyPath), { recursive: true });
    try {
      await readFile(blobMetadataPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const nonce = `${process.pid}.${randomUUID()}`;
      const tempBody = `${bodyPath}.${nonce}.tmp`;
      const tempMetadata = `${blobMetadataPath}.${nonce}.tmp`;
      const charset = response.contentType?.match(/charset=([^;\s]+)/i)?.[1] || "utf-8";
      const metadata = {
        schemaVersion: "huangque.artifact-blob.v2",
        hash,
        contentType: response.contentType,
        charset,
        bytes: response.bytes,
        encoding: "gzip",
        payloadEncoding: "raw_http_bytes",
      };
      try {
        await writeFile(tempBody, await gzipAsync(rawBody), { mode: 0o600 });
        await writeFile(tempMetadata, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        throwIfOperationAborted();
        await rename(tempBody, bodyPath);
        await rename(tempMetadata, blobMetadataPath);
      } finally {
        await unlink(tempBody).catch((cleanupError) => { if (cleanupError?.code !== "ENOENT") throw cleanupError; });
        await unlink(tempMetadata).catch((cleanupError) => { if (cleanupError?.code !== "ENOENT") throw cleanupError; });
      }
    }
    // The bytes are content-addressed and may be shared, while provenance is
    // observation-addressed. Never let the first writer's run/source metadata
    // stand in for later observations of the same payload.
    const observationId = `observation-${hash.slice(0, 16)}-${randomUUID()}`;
    const observationPath = join(this.root, "observations", prefix, `${observationId}.json`);
    await mkdir(dirname(observationPath), { recursive: true });
    const observation = {
      schemaVersion: "huangque.artifact-observation.v2",
      id: observationId,
      contentHash: hash,
      kind,
      sourceId,
      runId,
      page,
      requestedUrl: response.requestedUrl,
      finalUrl: response.finalUrl,
      status: response.status,
      contentType: response.contentType,
      bytes: response.bytes,
      fetchedAt: response.fetchedAt,
    };
    const nonce = `${process.pid}.${randomUUID()}`;
    const tempObservation = `${observationPath}.${nonce}.tmp`;
    try {
      await writeFile(tempObservation, `${JSON.stringify(observation, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      throwIfOperationAborted();
      await rename(tempObservation, observationPath);
    } finally {
      await unlink(tempObservation).catch((cleanupError) => { if (cleanupError?.code !== "ENOENT") throw cleanupError; });
    }
    return {
      hash,
      contentHash: hash,
      observationId,
      bodyPath,
      metadataPath: observationPath,
      observationPath,
      blobMetadataPath,
    };
  }

  async get(hash) {
    const requestedHash = String(hash || "");
    if (!/^[a-f0-9]{64}$/.test(requestedHash)) throw new TypeError("artifact hash 无效");
    const prefix = requestedHash.slice(0, 2);
    const metadataPath = join(this.root, prefix, `${requestedHash}.json`);
    const bodyPath = join(this.root, prefix, `${requestedHash}.gz`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const rawBody = await gunzipAsync(await readFile(bodyPath));
    const actualHash = createHash("sha256").update(rawBody).digest("hex");
    if (metadata.hash !== requestedHash || actualHash !== requestedHash || Number(metadata.bytes) !== rawBody.byteLength) {
      throw Object.assign(new Error("artifact 内容、元数据与请求 hash 不一致"), { code: "ARTIFACT_INTEGRITY_FAILURE" });
    }
    let body;
    try { body = new TextDecoder(metadata.charset || "utf-8", { fatal: false }).decode(rawBody); }
    catch { body = new TextDecoder("utf-8", { fatal: false }).decode(rawBody); }
    return { metadata, rawBody, body };
  }

  async getObservation(observationId) {
    const match = String(observationId || "").match(/^observation-([a-f0-9]{16})-[0-9a-f-]{36}$/);
    if (!match) throw new TypeError("artifact observationId 无效");
    const prefix = match[1].slice(0, 2);
    const observationPath = join(this.root, "observations", prefix, `${observationId}.json`);
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    if (observation.id !== observationId
      || !/^[a-f0-9]{64}$/.test(String(observation.contentHash || ""))
      || !String(observation.contentHash).startsWith(match[1])) {
      throw Object.assign(new Error("artifact observation 元数据不一致"), { code: "ARTIFACT_INTEGRITY_FAILURE" });
    }
    const replay = await this.get(observation.contentHash);
    return { observation, ...replay };
  }
}
