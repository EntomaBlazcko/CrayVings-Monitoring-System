// Import test file
import { test } from "./simple-test.js";

const CONSTANT = "test";

function processData(data) {
  return data.map(item => item * 2);
}

export { processData };