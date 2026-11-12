// Accept additive dependency fields; fail closed on invalid JSON or shape.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const health = JSON.parse(raw);
    process.exitCode = health?.dependencies?.gun?.status === 'external' ? 0 : 1;
  } catch { process.exitCode = 1; }
});
