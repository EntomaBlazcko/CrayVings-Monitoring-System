// Simple test file
const CONSTANT = "test";
const ANOTHER_CONSTANT = 42;

function processData(data) {
  return data.map(item => item * 2);
}

async function asyncProcess(data) {
  const processed = processData(data);
  return { result: processed };
}

function initialize() {
  console.log("Initialized");
}

export { processData, asyncProcess, initialize };