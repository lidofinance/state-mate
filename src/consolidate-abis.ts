import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { Abi, isValidAbi } from "./types";

interface ConsolidatedAbis {
  [key: string]: Abi;
}

function parseArguments(): { abiDirectoryPath: string; shouldCompress: boolean } {
  const arguments_ = process.argv.slice(2);
  const abiDirectoryPath = arguments_[0];
  const shouldCompress = arguments_.includes("--compress");

  if (!abiDirectoryPath) {
    console.error("Usage: ts-node src/consolidate-abis.ts <abi-directory-path> [--compress]");
    process.exit(1);
  }

  if (!fs.existsSync(abiDirectoryPath)) {
    console.error(`Error: Directory does not exist: ${abiDirectoryPath}`);
    process.exit(1);
  }

  return { abiDirectoryPath, shouldCompress };
}

function readAbiFiles(abiDirectoryPath: string): ConsolidatedAbis {
  const files = fs.readdirSync(abiDirectoryPath).filter((file) => file.endsWith(".json") && file !== "abis.json");

  console.log(`Found ${files.length} ABI files`);

  const consolidatedAbis: ConsolidatedAbis = {};

  for (const file of files) {
    const filePath = path.join(abiDirectoryPath, file);
    const key = file.replace(".json", "");

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const json: unknown = JSON.parse(content);

      // Handle both formats: raw array or {abi: [...]}
      let abi: unknown;
      if (Array.isArray(json)) {
        abi = json;
      } else if (typeof json === "object" && json !== null && "abi" in json) {
        abi = (json as { abi: unknown }).abi;
      } else {
        abi = json;
      }

      if (!isValidAbi(abi)) {
        console.error(`✗ Invalid ABI format in ${file}`);
        continue;
      }

      // Warn about duplicate keys
      if (consolidatedAbis[key]) {
        console.warn(`⚠ Duplicate key detected: ${key} (overwriting previous entry)`);
      }

      consolidatedAbis[key] = abi;
      console.log(`✓ ${key}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Error reading ${file}: ${errorMessage}`);
    }
  }

  return consolidatedAbis;
}

function writeConsolidatedAbis(
  abiDirectoryPath: string,
  consolidatedAbis: ConsolidatedAbis,
  shouldCompress: boolean,
): void {
  const outputFilename = shouldCompress ? "abis.json.gz" : "abis.json";
  // Output file is placed in the parent directory of the ABI folder
  // e.g., configs/myproject/abi/ -> configs/myproject/abis.json.gz
  const outputPath = path.join(path.dirname(abiDirectoryPath), outputFilename);
  const jsonContent = JSON.stringify(consolidatedAbis, null, 2);

  if (shouldCompress) {
    const compressed = zlib.gzipSync(jsonContent);
    fs.writeFileSync(outputPath, compressed);
  } else {
    fs.writeFileSync(outputPath, jsonContent);
  }

  console.log(`\n✓ Consolidated ${Object.keys(consolidatedAbis).length} ABIs into: ${outputPath}`);
  console.log(`File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);

  if (shouldCompress) {
    const originalSize = Buffer.byteLength(jsonContent, "utf8");
    const compressedSize = fs.statSync(outputPath).size;
    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    console.log(`Compression ratio: ${ratio}% reduction`);
  }
}

function main(): void {
  const { abiDirectoryPath, shouldCompress } = parseArguments();

  console.log(`Consolidating ABIs from: ${abiDirectoryPath}`);

  const consolidatedAbis = readAbiFiles(abiDirectoryPath);
  writeConsolidatedAbis(abiDirectoryPath, consolidatedAbis, shouldCompress);
}

main();
