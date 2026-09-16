import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");

test("directory auto-loading handles mixed configs, records paths, and resets selection per config", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-mate-auto-"));
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const reply = (call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.isArray(payload) ? payload.map(reply) : reply(payload)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const network = `l1: {rpcUrl: "http://127.0.0.1:${address.port}", chainId: 1, contracts: {}}\n`;
    const deployed = 'deployed: {l1: [&address "0x1111111111111111111111111111111111111111"]}\n';
    fs.mkdirSync(path.join(directory, "nested"));
    const fixtures = [
      { stem: "a", deployed: true, inputs: true },
      { stem: "b", deployed: false, inputs: false },
      { stem: "nested/c", deployed: true, inputs: false },
      { stem: "nested/d", deployed: false, inputs: true },
    ];
    for (const fixture of fixtures) {
      const refs = [fixture.deployed ? "*address" : "", fixture.inputs ? "*value" : ""].filter(Boolean);
      fs.writeFileSync(
        path.join(directory, `${fixture.stem}.yaml`),
        `${fixture.deployed ? "" : "deployed: {l1: []}\n"}${network}misc: [${refs.join(", ")}]\n`,
      );
      if (fixture.deployed) fs.writeFileSync(path.join(directory, `${fixture.stem}.deployed.yml`), deployed);
      if (fixture.inputs)
        fs.writeFileSync(path.join(directory, `${fixture.stem}.inputs.yaml`), "config: [&value true]\n");
    }
    const run = () =>
      exec(
        process.execPath,
        [
          "--require",
          "ts-node/register",
          "--require",
          "tsconfig-paths/register",
          "src/state-mate.ts",
          directory,
          "--auto-load-deployed-and-inputs",
          "--json",
        ],
        { cwd: root, timeout: 30_000 },
      );
    const { stdout } = await run();
    const report = JSON.parse(stdout);
    assert.equal(report.status, "passed");
    assert.equal(report.configs.length, 4);
    for (const [index, fixture] of fixtures.entries()) {
      const entry = report.configs[index];
      assert.equal(entry.config, path.join(directory, `${fixture.stem}.yaml`));
      assert.equal(entry.deployed, fixture.deployed ? path.join(directory, `${fixture.stem}.deployed.yml`) : undefined);
      assert.equal(entry.inputs, fixture.inputs ? path.join(directory, `${fixture.stem}.inputs.yaml`) : undefined);
    }

    // A later discovery error must retain both the completed config and the aborted one,
    // without attributing the first config's sibling paths to the second.
    for (const extension of ["yaml", "yml"]) {
      fs.writeFileSync(path.join(directory, `b.deployed.${extension}`), deployed);
    }
    await assert.rejects(run(), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stderr, "");
      const aborted = JSON.parse(failure.stdout);
      assert.equal(aborted.status, "error");
      assert.equal(aborted.summary.configs, 2);
      assert.equal(aborted.configs[0].status, "passed");
      assert.equal(aborted.configs[1].config, path.join(directory, "b.yaml"));
      assert.equal(aborted.configs[1].status, "error");
      assert.match(aborted.configs[1].error, /Ambiguous deployed siblings/);
      assert.equal(aborted.configs[1].deployed, undefined);
      assert.equal(aborted.configs[1].inputs, undefined);
      assert.equal(aborted.configs[1].checks, 0);
      return true;
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
