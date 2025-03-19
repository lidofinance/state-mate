import fs from "node:fs";
import path from "node:path";

import "dotenv/config";

import { TObject } from "@sinclair/typebox";
import chalk from "chalk";

import { printError } from "./common";
import { logErrorAndExit, logHeader1 } from "./logger";
import { EntireDocumentTB, SeedDocumentTB } from "./typebox";

function generateBothSchemas() {
  const schemasPath = path.resolve(path.dirname(__dirname), path.join("schemas"));
  fs.mkdirSync(schemasPath, { recursive: true });

  const saveSchema = (fileName: string, schema: TObject) => {
    const schemasFilePath = path.resolve(schemasPath, fileName);
    try {
      fs.writeFileSync(schemasFilePath, JSON.stringify(schema, null, 2), "utf8");
      logHeader1(`The JSON Schema has been saved to ${chalk.green(schemasFilePath)}`);
    } catch (error) {
      logErrorAndExit(
        `Failed to save the JSON Schema to ${chalk.red(schemasFilePath)}:\n\n${chalk.red(printError(error))}`,
      );
    }
  };
  saveSchema("main-schema.json", EntireDocumentTB);
  saveSchema("seed-schema.json", SeedDocumentTB);
}
async function main() {
  generateBothSchemas();
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => console.error(error));
