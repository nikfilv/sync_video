try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}/health`, {
    signal: AbortSignal.timeout(3000)
  });
  const body = await response.json();
  process.exit(response.ok && body.ok === true ? 0 : 1);
} catch {
  process.exit(1);
}
