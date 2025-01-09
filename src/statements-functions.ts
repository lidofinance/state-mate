import { assert, AssertionError } from "chai";
import { ArbitraryObject, ViewResult } from "./typebox";
import { Result } from "ethers";

// Supports bigint as object values
export function stringify(value: unknown) {
  if (value instanceof Object) {
    return JSON.stringify(value);
  } else {
    return `${String(value)}`;
  }
}

export function assertEqual(actual: unknown, expected: ViewResult, errorMessage?: string) {
  if (typeof actual === "bigint") {
    assert(typeof expected === "string" || typeof expected === "bigint");
    equalOrThrow(actual, BigInt(expected), errorMessage);
  } else if (Array.isArray(expected)) {
    equalOrThrow(
      (actual as unknown[]).length,
      expected.length,
      `Array length differ: actual = '${String(actual)}', expected = '${String(expected)}'`,
    );
    if (!errorMessage) {
      errorMessage = `Actual value '${String(actual)} is not equal to expected array '[${String(expected)}]`;
    }
    for (let i = 0; i < (actual as unknown[]).length; ++i) {
      assertEqual((actual as unknown[])[i], expected[i], errorMessage);
    }
  } else if (typeof expected === "object") {
    assertEqualStruct(expected, actual as Result);
  } else {
    equalOrThrow(actual, expected, errorMessage);
  }
}

export function assertEqualStruct(expected: null | ArbitraryObject, actual: Result) {
  if (expected === null) {
    return;
  }

  const actualAsObject = actual.toObject();
  const errorMessage = `expected ${stringify(actualAsObject)} to equal ${stringify(expected)}`;

  equalOrThrow(Object.keys(actualAsObject).length, Object.keys(expected).length, errorMessage);
  for (const field in actualAsObject) {
    const expectedValue = expected[field];
    if (expectedValue === null) {
      continue;
    }
    let actualValue: unknown = actualAsObject[field];
    const errorMessageDetailed = errorMessage + ` but fields "${field}" differ`;
    if (actualValue instanceof Result && (expectedValue as unknown) instanceof Array) {
      actualValue = actualValue.toArray();
    }
    assertEqual(actualValue, expectedValue, errorMessageDetailed);
  }
}

function equalOrThrow(actual: unknown, expected: unknown, errorMessage?: string) {
  if (actual !== expected) {
    if (!errorMessage) {
      errorMessage = `Expected "${stringify(expected)}" to equal actual "${stringify(actual)}"`;
    }
    throw new AssertionError(errorMessage);
  }
}
