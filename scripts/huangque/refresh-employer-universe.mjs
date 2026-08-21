#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshEmployerUniverse } from "./lib/employer-universe.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArguments(argv) {
  const options = {
    outputPath: resolve(projectRoot, "data/huangque/employer-universe.json"),
    allowSasacSnapshotFallback: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-live-sasac") options.allowSasacSnapshotFallback = false;
    else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError("--output 需要文件路径");
      options.outputPath = resolve(value);
      index += 1;
    } else if (["--help", "-h"].includes(argument)) {
      options.help = true;
    } else {
      throw new TypeError(`未知参数：${argument}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write([
      "黄雀 Oriole：刷新 5000+ 用人单位目标库",
      "",
      "用法：node scripts/huangque/refresh-employer-universe.mjs [选项]",
      "",
      "  --output <path>             输出路径",
      "  --require-live-sasac        国资委在线目录失败时禁止使用版本化快照",
      "  --help                      显示帮助",
      "",
    ].join("\n"));
    return null;
  }
  const payload = await refreshEmployerUniverse(options);
  const summary = {
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.metadata.generatedAt,
    outputPath: options.outputPath,
    totalTargets: payload.stats.totalTargets,
    rawRecords: payload.stats.rawRecords,
    mergedDuplicates: payload.stats.mergedDuplicates,
    sourceRecords: payload.stats.sourceRecords,
    sourceModes: Object.fromEntries(payload.sources.map((source) => [source.id, source.mode])),
    allSourcesLive: payload.metadata.allSourcesLive,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`用人单位目标库刷新失败 [${error.code || "EMPLOYER_UNIVERSE_REFRESH_FAILED"}]：${error.message}\n`);
    process.exitCode = 1;
  });
}
